import "server-only";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, resources, settings, snapshots } from "@/db/schema";
import { credentialProblem, statusAfterTest } from "@/lib/accounts";
import { openOrNull } from "@/lib/crypto";
import { recordEvents } from "@/lib/data/events-write";
import { mergeSnapshot, writeState } from "@/lib/data/snapshots-db";
import { serverEnv } from "@/lib/env";
import { factsOf, rdapFact, tlsFact } from "@/lib/network/facts";
import { fetchBootstrap, lookupDomain, rdapBase, type Services } from "@/lib/network/rdap";
import {
  domainState, dueForRefresh, isVercelHost, isoDate, MAX_ITEMS_PER_RUN, networkEvent, recordsFor, zoneFor, zoneState,
} from "@/lib/network/rules";
import { readCertificate } from "@/lib/network/tls";
import { certificatePacks, listDnsRecords, listZones, sslMode } from "@/lib/providers/cloudflare";
import { domainConfig, listProjectDomains } from "@/lib/providers/vercel";
import { EOL_SETTINGS_KEY, fetchNextCycles } from "@/lib/security/eol";
import { saveAppDomains, upsertZones } from "@/lib/sync-db";
import { mapLimit } from "./http-check";
import type { NewEvent } from "./rules";

// Stage 4 collector tasks. Every provider call is a GET (owner rule). Each task writes only its own snapshot keys and
// stops starting new work past the run deadline; whatever it didn't reach is picked up by its next run.

export const NETWORK_TASKS = ["cloudflare", "domains", "tls", "rdap", "eol"] as const;
const TLS_TIMEOUT_MS = 5_000;
const ITEM_MARGIN_MS = 6_000; // don't start a TLS or RDAP read with less than this left
const sqlExcludedMeta = sql`excluded.meta`;

async function tokensFor(provider: "vercel" | "cloudflare") {
  const key = serverEnv().OPS_ENCRYPTION_KEY;
  const accs = await db().select().from(accounts).where(and(eq(accounts.provider, provider), eq(accounts.status, "ok")));
  return accs.map((acc) => {
    const token = openOrNull({ ciphertext: acc.credentialCiphertext, iv: acc.credentialIv }, key);
    return { acc, token: credentialProblem(token) ? null : token };
  });
}

export async function taskCloudflare(now: Date, deadline: number, errors: string[]): Promise<void> {
  for (const { acc, token } of await tokensFor("cloudflare")) {
    if (!token) {
      errors.push(`cloudflare/${acc.label}: credential can't be read`);
      continue;
    }
    const zones = await listZones(token);
    if (!zones.ok) {
      const change = statusAfterTest({ ok: false, kind: zones.kind === "scope" ? "auth" : zones.kind, error: zones.error });
      if (change) await db().update(accounts).set({ ...change, updatedAt: now }).where(eq(accounts.id, acc.id));
      errors.push(`cloudflare/${acc.label}: ${zones.error}`);
      if (zones.status === 429) return; // spend nothing more this hour
      continue;
    }
    await upsertZones(acc.id, acc.watchNew, zones.data, now);
    const watched = await db().select().from(resources)
      .where(and(eq(resources.accountId, acc.id), eq(resources.kind, "zone"), eq(resources.monitored, true), isNull(resources.goneAt)));
    for (const z of watched) {
      // A zone makes up to four sequential 5 s record pages, so don't start one with less than the margin left (review M1).
      if (deadline - Date.now() < ITEM_MARGIN_MS) {
        errors.push("cloudflare: skipped remaining zones, time budget used");
        return;
      }
      const cf = zones.data.find((x) => x.id === z.externalId);
      const [recs, ssl, packs] = await Promise.all([listDnsRecords(token, z.externalId), sslMode(token, z.externalId), certificatePacks(token, z.externalId)]);
      const failed = [recs, ssl, packs].flatMap((r) => (r.ok ? [] : [r]));
      const patch: Record<string, unknown> = {
        zone: { status: cf?.status ?? null, paused: cf?.paused ?? false, nameServers: cf?.nameServers ?? [], accountId: cf?.accountId ?? null, checkedAt: now.toISOString() },
        // A missing permission clears that part honestly ("Unknown"), instead of showing an old value as current.
        ssl: ssl.ok ? { mode: ssl.data, error: null } : { mode: null, error: ssl.error },
        cfErrors: failed.map((f) => f.error),
      };
      // Same for records and certificates: a lost permission (kind "scope") clears them; a transient failure keeps the last read.
      if (recs.ok) Object.assign(patch, { records: recs.data.records, recordsTruncated: recs.data.truncated });
      else if (recs.kind === "scope") Object.assign(patch, { records: [], recordsTruncated: false });
      if (packs.ok) patch.certs = packs.data;
      else if (packs.kind === "scope") patch.certs = [];
      await mergeSnapshot(z.id, patch, now);
      for (const f of failed) if (f.kind !== "scope") errors.push(`cloudflare/${z.name}: ${f.error}`);
      if (failed.some((f) => f.status === 429)) return;
    }
  }
}

export async function taskDomains(now: Date, deadline: number, errors: string[]): Promise<void> {
  for (const { acc, token } of await tokensFor("vercel")) {
    if (!token) continue; // taskVercel already reports an unreadable Vercel credential every minute
    const apps = await db().select().from(resources).where(and(eq(resources.accountId, acc.id), eq(resources.kind, "app")));
    const watched = apps.filter((a) => a.monitored && !a.goneAt);
    const unwatched = apps.filter((a) => !a.monitored || a.goneAt).map((a) => a.id);
    if (unwatched.length) {
      await db().update(resources).set({ monitored: false, updatedAt: now }).where(and(eq(resources.kind, "domain"), inArray(resources.parentId, unwatched)));
    }
    for (const app of watched) {
      if (Date.now() > deadline) {
        errors.push("domains: skipped remaining apps, time budget used");
        return;
      }
      const teamId = String(app.meta.teamId ?? "");
      const list = await listProjectDomains(token, teamId, app.externalId);
      if (!list.ok) {
        errors.push(`domains/${app.name}: ${list.error}`);
        if (list.status === 429) return; // spend nothing more this run
        if (list.kind === "auth") break; // this account's token can't read domains; other accounts still can (review M2)
        continue;
      }
      // 1.2.1: the app's domains and primary domain, so a move is seen without a manual Sync (lib/domain-move.ts).
      await saveAppDomains(app.id, app.name, app.meta, list.data);
      const keep = list.data.filter((d) => !d.gitBranch); // preview-branch domains aren't production
      const rows = keep.length
        ? await db().insert(resources).values(keep.map((d) => ({
          accountId: acc.id, kind: "domain" as const, externalId: d.name, name: d.name, parentId: app.id, monitored: true,
          meta: { redirect: d.redirect, verified: d.verified, projectId: app.externalId }, lastSeenAt: now,
        }))).onConflictDoUpdate({
          target: [resources.accountId, resources.kind, resources.externalId],
          set: { parentId: app.id, monitored: true, goneAt: null, lastSeenAt: now, updatedAt: now, meta: sqlExcludedMeta },
        }).returning({ id: resources.id, name: resources.name })
        : [];
      await db().update(resources).set({ goneAt: now, updatedAt: now }).where(and(
        eq(resources.kind, "domain"), eq(resources.parentId, app.id), isNull(resources.goneAt),
        keep.length ? notInArray(resources.externalId, keep.map((d) => d.name)) : undefined,
      ));
      for (const row of rows.filter((r) => !isVercelHost(r.name))) {
        if (Date.now() > deadline) return;
        const cfg = await domainConfig(token, teamId, row.name);
        if (cfg.ok) await mergeSnapshot(row.id, { vercel: { ...cfg.data, checkedAt: now.toISOString() } }, now);
        else if (cfg.kind === "transient") errors.push(`domains/${row.name}: ${cfg.error}`);
      }
    }
  }
}

async function domainRows() {
  return db().select({ r: resources, s: snapshots }).from(resources).leftJoin(snapshots, eq(snapshots.resourceId, resources.id))
    .where(and(eq(resources.kind, "domain"), eq(resources.monitored, true), isNull(resources.goneAt)));
}
async function zoneRows() {
  return db().select({ r: resources, s: snapshots }).from(resources).leftJoin(snapshots, eq(snapshots.resourceId, resources.id))
    .where(and(eq(resources.kind, "zone"), eq(resources.monitored, true), isNull(resources.goneAt)));
}
const oldestFirst = (a: unknown, b: unknown) => (isoDate(a)?.getTime() ?? 0) - (isoDate(b)?.getTime() ?? 0);

export async function tlsForDomain(domainId: string, host: string, now: Date): Promise<void> {
  const [row] = await db().select({ data: snapshots.data }).from(snapshots).where(eq(snapshots.resourceId, domainId)).limit(1);
  const r = await readCertificate(host, { timeoutMs: TLS_TIMEOUT_MS });
  await mergeSnapshot(domainId, { tls: tlsFact(r, factsOf(row?.data).tls, now) }, now);
}

export async function taskTls(now: Date, deadline: number, errors: string[]): Promise<void> {
  const due = (await domainRows())
    .filter(({ r, s }) => !isVercelHost(r.name) && dueForRefresh(factsOf(s?.data).tls?.checkedAt, now))
    .sort((a, b) => oldestFirst(factsOf(a.s?.data).tls?.checkedAt, factsOf(b.s?.data).tls?.checkedAt))
    .slice(0, MAX_ITEMS_PER_RUN);
  await mapLimit(due, 4, async ({ r }) => {
    if (deadline - Date.now() < ITEM_MARGIN_MS) return;
    try {
      await tlsForDomain(r.id, r.name, now);
    } catch {
      errors.push(`tls/${r.name}: couldn't save the result`);
    }
  });
}

// Returns the error text, or null when the registry answered.
export async function rdapForZone(zoneId: string, name: string, now: Date, services?: Services): Promise<string | null> {
  const [row] = await db().select({ data: snapshots.data }).from(snapshots).where(eq(snapshots.resourceId, zoneId)).limit(1);
  const prev = factsOf(row?.data).rdap;
  let list = services;
  if (!list) {
    const boot = await fetchBootstrap();
    if (!boot.ok) return boot.error; // nothing written: try again next hour
    list = boot.services;
  }
  const base = rdapBase(list, name);
  const r = base ? await lookupDomain(name, base) : { ok: false as const, error: "The registry has no RDAP server" };
  await mergeSnapshot(zoneId, { rdap: rdapFact(r, prev, now) }, now);
  return r.ok ? null : r.error;
}

export async function taskRdap(now: Date, deadline: number, errors: string[]): Promise<void> {
  const due = (await zoneRows())
    .filter(({ r, s }) => r.monitored && dueForRefresh(factsOf(s?.data).rdap?.checkedAt, now))
    .sort((a, b) => oldestFirst(factsOf(a.s?.data).rdap?.checkedAt, factsOf(b.s?.data).rdap?.checkedAt))
    .slice(0, MAX_ITEMS_PER_RUN);
  if (!due.length) return;
  const boot = await fetchBootstrap();
  if (!boot.ok) {
    errors.push(`rdap: ${boot.error}`);
    return;
  }
  for (const { r } of due) {
    if (deadline - Date.now() < ITEM_MARGIN_MS) return;
    const err = await rdapForZone(r.id, r.name, now, boot.services);
    // A registry without RDAP is a fact, not a collector problem; real failures are reported.
    if (err && err !== "The registry has no RDAP server") errors.push(`rdap/${r.name}: ${err}`);
  }
}

// Same run deadline as the other tasks: runCollector defers it with under 6 s left (MIN_LEFT_MS), and its one read is
// cut to what is left of the run (at most 8 s), so a late start can't push the run past /api/collect's limit.
const EOL_TIMEOUT_MS = 8_000;
export async function taskEol(now: Date, deadline: number, errors: string[]): Promise<void> {
  const left = deadline - Date.now();
  if (left < 1_000) throw new Error("skipped, time budget used"); // not marked as run: due again next run
  const r = await fetchNextCycles({ timeoutMs: Math.min(EOL_TIMEOUT_MS, left) });
  if (!r.ok) {
    errors.push(`eol: ${r.error}`); // yesterday's data stays
    return;
  }
  const value = { cycles: r.cycles, checkedAt: now.toISOString() };
  await db().insert(settings).values({ key: EOL_SETTINGS_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}

// Zone and domain states from the merged snapshots, with an event per change (like monitors). Runs after any network
// task and after Re-check. Domains read DNS records and RDAP from the Cloudflare zone they sit in.
export async function refreshNetworkStates(now: Date): Promise<void> {
  const zones = await zoneRows();
  const evs: (NewEvent | null)[] = [];
  for (const { r, s } of zones.filter((z) => z.s)) {
    const f = factsOf(s!.data);
    const next = zoneState({ status: f.zone?.status ?? null, paused: f.zone?.paused ?? false, rdap: f.rdap }, now);
    if (next.state !== s!.state || JSON.stringify(next.reasons) !== JSON.stringify(f.reasons)) {
      await mergeSnapshot(r.id, { reasons: next.reasons }, now);
      if (next.state !== s!.state) await writeState(r.id, next.state, now);
      evs.push(networkEvent({ resourceId: r.id, name: r.name, prev: s!.state, next: next.state, reasons: next.reasons, at: now }));
    }
  }
  const zoneNames = zones.filter((z) => z.r.monitored).map((z) => z.r.name);
  for (const { r, s } of await domainRows()) {
    const f = factsOf(s?.data);
    const zoneName = zoneFor(r.name, zoneNames);
    const zone = zoneName ? factsOf(zones.find((z) => z.r.name === zoneName)?.s?.data) : null;
    const next = domainState({ host: r.name, tls: f.tls, vercel: f.vercel, records: zone ? recordsFor(r.name, zone.records) : [], zoneRdap: zone?.rdap ?? null }, now);
    const prev = s?.state ?? null;
    if (next.state !== prev || JSON.stringify(next.reasons) !== JSON.stringify(f.reasons)) {
      await mergeSnapshot(r.id, { reasons: next.reasons }, now); // creates the row (unknown) when missing
      if (next.state !== prev) await writeState(r.id, next.state, now);
      evs.push(networkEvent({ resourceId: r.id, name: r.name, prev, next: next.state, reasons: next.reasons, at: now }));
    }
  }
  await recordEvents(evs); // reason codes and repeat counts (R2)
}
