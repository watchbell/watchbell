import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { resources, settings } from "@/db/schema";
import { classifyFailure } from "@/lib/databases/events";
import { d1State, tursoState, upstashState } from "@/lib/databases/extra";
import { type CfResult } from "@/lib/providers/cloudflare";
import { type D1Details, d1UsageOn, getD1, listAccounts, listD1, utcDay } from "@/lib/providers/cloudflare-d1";
import type { Result } from "@/lib/providers/http";
import { listTursoDatabases, listTursoOrgs, type TursoDb, type TursoOrgUsage, tursoOrgUsage } from "@/lib/providers/turso";
import { listUpstashRedis, parseUpstashCred, upstashStats } from "@/lib/providers/upstash";
import { D1_ACCESS_KEY, type D1Access } from "@/lib/view/extra-dbs";
import type { NewEvent } from "./rules";
import {
  accountDown, accountsOf, type Ctx, eachWithin, finish, type Item, saveEvents, settle, watchedOf, within, writeState,
} from "./db-tasks";

// Stage 8, hourly (:16): Turso, Upstash Redis and Cloudflare D1. Read-only API calls; nothing connects to a database.
//   Turso    per account: the organization list, then per organization its databases and this month's usage (3 + 2n calls)
//   Upstash  per account: the database list, then each watched database's stats
//   D1       per Cloudflare account: its Cloudflare accounts, each one's D1 list (new databases are watched at once,
//            like stage 4's domains), each database's size, and one GraphQL read of today's rows per Cloudflare account
// Each provider runs on its own, so one that fails or is slow doesn't hide the others.
export async function taskExtraDbs(ctx: Ctx): Promise<void> {
  const errs = [await settle(() => tursoTask(ctx)), await settle(() => upstashTask(ctx)), await settle(() => d1Task(ctx))];
  const first = errs.find((e) => e !== null);
  if (first) throw first;
}

const iso = (d: Date) => d.toISOString();

async function tursoTask(ctx: Ctx): Promise<void> {
  for (const { acc, credential } of await accountsOf("turso")) {
    within(ctx);
    if (!credential) { ctx.errors.push(`turso/${acc.label}: credential can't be read`); continue; }
    const items = await watchedOf(acc.id, "turso_database");
    if (!items.length) continue;
    const orgs = await listTursoOrgs(credential, within(ctx));
    if (!orgs.ok) { await accountDown("turso", acc, items, orgs, ctx); continue; }
    const wanted = new Set(items.map((it) => String(it.r.meta.org ?? "")));
    const evs: (NewEvent | null)[] = [];
    for (const org of orgs.data.filter((o) => wanted.has(o.slug))) {
      const [dbs, usage] = await Promise.all([listTursoDatabases(credential, org.slug, within(ctx)), tursoOrgUsage(credential, org.slug, within(ctx))]);
      const mine = items.filter((it) => it.r.meta.org === org.slug);
      if (!dbs.ok) {
        for (const it of mine) await writeState(it, { state: "unknown", label: "Unknown", patch: {} }, ctx.now);
        ctx.errors.push(`turso/${acc.label}: ${dbs.error}`);
        continue;
      }
      const byId = new Map(dbs.data.map((d) => [d.id, d]));
      for (const it of mine) evs.push(await tursoWrite(it, byId.get(it.r.externalId), org, usage, ctx));
    }
    // Watched databases of an organization the token no longer sees.
    const seen = new Set(orgs.data.map((o) => o.slug));
    for (const it of items.filter((x) => !seen.has(String(x.r.meta.org ?? "")))) {
      evs.push(await writeState(it, { state: "off", label: "Organization not visible to this token", patch: {} }, ctx.now));
    }
    await saveEvents(evs);
  }
}

async function tursoWrite(
  it: Item, d: TursoDb | undefined, org: { slug: string; plan: string | null; blockedReads: boolean; blockedWrites: boolean },
  usage: Result<TursoOrgUsage>, ctx: Ctx,
): Promise<NewEvent | null> {
  if (!d) return writeState(it, { state: "off", label: "Not found", patch: {} }, ctx.now);
  const st = tursoState({ blockReads: d.blockReads, blockWrites: d.blockWrites, orgBlockedReads: org.blockedReads, orgBlockedWrites: org.blockedWrites });
  const patch: Record<string, unknown> = {
    org: org.slug, group: d.group, primaryRegion: d.primaryRegion, plan: org.plan, blockReads: d.blockReads, blockWrites: d.blockWrites,
  };
  if (usage.ok) {
    const mine = usage.data.byDb.get(d.id);
    Object.assign(patch, {
      rowsRead: mine?.rowsRead ?? null, rowsWritten: mine?.rowsWritten ?? null, storageBytes: mine?.storageBytes ?? null,
      orgRowsRead: usage.data.org.rowsRead, orgRowsWritten: usage.data.org.rowsWritten, orgStorageBytes: usage.data.org.storageBytes,
      orgDatabases: usage.data.org.databases, usageAt: iso(ctx.now), usageError: null,
    });
  } else if (classifyFailure(usage, false) === "column") patch.usageError = usage.error;
  else ctx.errors.push(`turso/${it.r.name} usage: ${usage.error}`);
  return writeState(it, { ...st, patch }, ctx.now);
}

async function upstashTask(ctx: Ctx): Promise<void> {
  for (const { acc, credential } of await accountsOf("upstash")) {
    within(ctx);
    const cred = credential ? parseUpstashCred(credential) : null;
    if (!cred) { ctx.errors.push(`upstash/${acc.label}: credential can't be read`); continue; }
    const items = await watchedOf(acc.id, "upstash_redis");
    if (!items.length) continue;
    const list = await listUpstashRedis(cred, within(ctx));
    if (!list.ok) { await accountDown("upstash", acc, items, list, ctx); continue; }
    const byId = new Map(list.data.map((d) => [d.id, d]));
    const { out: stats, skipped } = await eachWithin(ctx, items, (it, o) => (byId.has(it.r.externalId) ? upstashStats(cred, it.r.externalId, o) : Promise.resolve(null)));
    const evs: (NewEvent | null)[] = [];
    for (const [i, it] of items.entries()) {
      const d = byId.get(it.r.externalId);
      if (!d) { evs.push(await writeState(it, { state: "off", label: "Not found", patch: {} }, ctx.now)); continue; }
      const st = upstashState(d.state);
      const patch: Record<string, unknown> = { region: d.region, status: d.state, type: d.type };
      const s = stats[i];
      if (s?.ok) Object.assign(patch, { ...s.data, statsAt: iso(ctx.now), statsError: null });
      else if (s && classifyFailure(s, false) === "column") patch.statsError = s.error;
      else if (s) ctx.errors.push(`upstash/${it.r.name} stats: ${s.error}`);
      evs.push(await writeState(it, { ...st, patch }, ctx.now));
    }
    await saveEvents(evs);
    finish(skipped);
  }
}

// ---- Cloudflare D1 ----

async function d1Task(ctx: Ctx): Promise<void> {
  const access: D1Access = {};
  for (const { acc, credential } of await accountsOf("cloudflare")) {
    within(ctx);
    if (!credential) continue; // the hourly Cloudflare task already reports an unreadable credential
    const cfAccounts = await cloudflareAccountIds(acc.id, credential, ctx);
    if (!cfAccounts.length) { access[acc.id] = { d1: "error", analytics: null, at: iso(ctx.now), note: "No Cloudflare account found for this token" }; continue; }
    let d1: D1Access[string]["d1"] = "ok";
    let analytics: D1Access[string]["analytics"] = null;
    for (const cfId of cfAccounts) {
      const list = await listD1(credential, cfId, within(ctx));
      if (!list.ok) {
        d1 = list.kind === "scope" || list.kind === "auth" ? "missing" : "error";
        if (d1 === "error") ctx.errors.push(`d1/${acc.label}: ${list.error}`);
        continue;
      }
      await upsertD1(acc.id, cfId, list.data, ctx.now);
      const items = (await watchedOf(acc.id, "d1_database")).filter((it) => it.r.meta.accountId === cfId);
      if (!items.length) continue;
      const usage = await d1UsageOn(credential, cfId, utcDay(ctx.now), within(ctx));
      analytics = usage.ok ? (analytics ?? "ok") : usage.kind === "scope" ? "missing" : analytics ?? "error";
      if (!usage.ok && usage.kind !== "scope") ctx.errors.push(`d1/${acc.label} analytics: ${usage.error}`);
      const { out: details, skipped } = await eachWithin(ctx, items, (it, o) => getD1(credential, cfId, it.r.externalId, o));
      const byDb = new Map((usage.ok ? usage.data : []).map((u) => [u.databaseId, u]));
      const sizes = details.map((d) => (d?.ok ? d.data.sizeBytes ?? 0 : 0));
      const totals = {
        accountRowsRead: usage.ok ? usage.data.reduce((n, u) => n + u.rowsRead, 0) : null,
        accountRowsWritten: usage.ok ? usage.data.reduce((n, u) => n + u.rowsWritten, 0) : null,
        accountSizeBytes: details.every((d) => d?.ok) ? sizes.reduce((n, x) => n + x, 0) : null,
        accountDatabases: list.data.length,
      };
      const evs: (NewEvent | null)[] = [];
      for (const [i, it] of items.entries()) {
        const det = details[i];
        if (det === undefined) continue; // not started: the run ran out of time
        evs.push(await d1Write(it, det, byDb.get(it.r.externalId) ?? null, usage.ok, usage.ok ? null : usage.error, totals, ctx));
      }
      await saveEvents(evs);
      finish(skipped);
    }
    access[acc.id] = { d1, analytics, at: iso(ctx.now), note: null };
  }
  const value = access;
  await db().insert(settings).values({ key: D1_ACCESS_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: ctx.now } });
}

async function d1Write(
  it: Item, det: CfResult<D1Details>, u: { rowsRead: number; rowsWritten: number; readQueries: number; writeQueries: number } | null,
  usageOk: boolean, usageError: string | null,
  totals: { accountRowsRead: number | null; accountRowsWritten: number | null; accountSizeBytes: number | null; accountDatabases: number }, ctx: Ctx,
): Promise<NewEvent | null> {
  const patch: Record<string, unknown> = { accountId: it.r.meta.accountId ?? null, createdAt: it.r.meta.createdAt ?? null, accountDatabases: totals.accountDatabases };
  if (det.ok) Object.assign(patch, { sizeBytes: det.data.sizeBytes, numTables: det.data.numTables, readReplication: det.data.readReplication, detailsAt: iso(ctx.now), detailsError: null });
  else if (det.kind === "scope") patch.detailsError = det.error;
  else ctx.errors.push(`d1/${it.r.name}: ${det.error}`);
  if (usageOk) {
    Object.assign(patch, {
      rowsRead: u?.rowsRead ?? 0, rowsWritten: u?.rowsWritten ?? 0, readQueries: u?.readQueries ?? 0, writeQueries: u?.writeQueries ?? 0,
      accountRowsRead: totals.accountRowsRead, accountRowsWritten: totals.accountRowsWritten, usageDay: utcDay(ctx.now), usageAt: iso(ctx.now), usageError: null,
    });
  } else patch.usageError = usageError;
  if (totals.accountSizeBytes !== null) patch.accountSizeBytes = totals.accountSizeBytes;
  if (!det.ok && det.kind === "transient") return writeState(it, { state: "unknown", label: "Unknown", patch: {} }, ctx.now);
  const st = d1State(usageOk ? totals : { accountRowsRead: null, accountRowsWritten: null });
  return writeState(it, { ...st, patch }, ctx.now);
}

// The Cloudflare accounts this token reaches: GET /accounts, else the accounts of the zones Sync stored (a token
// without account-level permissions may not list accounts at all).
async function cloudflareAccountIds(accountId: string, token: string, ctx: Ctx): Promise<string[]> {
  const ids = new Set<string>();
  const listed = await listAccounts(token, within(ctx));
  if (listed.ok) for (const a of listed.data) ids.add(a.id);
  const zones = await db().select({ meta: resources.meta }).from(resources)
    .where(and(eq(resources.accountId, accountId), eq(resources.kind, "zone"), isNull(resources.goneAt))).limit(200);
  for (const z of zones) if (typeof z.meta.accountId === "string" && /^[0-9a-f]{32}$/i.test(z.meta.accountId)) ids.add(z.meta.accountId);
  return [...ids].slice(0, 5);
}

// New D1 databases are watched at once (there are at most 10 on the free plan, and D1 has no Sync dialog of its own);
// renamed ones are renamed, vanished ones marked gone. Only databases of a Cloudflare account that was just listed.
async function upsertD1(accountId: string, cfAccountId: string, list: { uuid: string; name: string; createdAt: string | null }[], now: Date): Promise<void> {
  const existing = (await db().select({ id: resources.id, externalId: resources.externalId, meta: resources.meta, goneAt: resources.goneAt }).from(resources)
    .where(and(eq(resources.accountId, accountId), eq(resources.kind, "d1_database")))).filter((r) => r.meta.accountId === cfAccountId);
  const known = new Map(existing.map((r) => [r.externalId, r]));
  const seen = new Set(list.map((d) => d.uuid));
  await db().transaction(async (tx) => {
    for (const d of list) {
      const meta = { accountId: cfAccountId, createdAt: d.createdAt };
      const row = known.get(d.uuid);
      if (row) await tx.update(resources).set({ name: d.name, meta, lastSeenAt: now, goneAt: null, updatedAt: now }).where(eq(resources.id, row.id));
      else {
        await tx.insert(resources).values({ accountId, kind: "d1_database", externalId: d.uuid, name: d.name, meta, monitored: true, lastSeenAt: now })
          .onConflictDoNothing({ target: [resources.accountId, resources.kind, resources.externalId] });
      }
    }
    const gone = existing.filter((r) => !seen.has(r.externalId) && !r.goneAt).map((r) => r.id);
    if (gone.length) await tx.update(resources).set({ goneAt: now, updatedAt: now }).where(inArray(resources.id, gone));
  });
}

