import "server-only";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, monitors, resources } from "@/db/schema";
import { credentialProblem, statusAfterTest } from "@/lib/accounts";
import { openOrNull } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { type CfZone, listZones, tokenStatus } from "@/lib/providers/cloudflare";
import { discoverFirebase } from "@/lib/providers/firebase";
import { googleAccessToken, parseServiceAccount } from "@/lib/providers/google";
import type { Provider } from "@/lib/providers/info";
import { discoverNeon } from "@/lib/providers/neon";
import { listProjects as listSupabaseProjects } from "@/lib/providers/supabase";
import { discoverTurso } from "@/lib/providers/turso";
import { listUpstashRedis, parseUpstashCred } from "@/lib/providers/upstash";
import { appDomainsMeta } from "@/lib/domain-move";
import { discoverVercel, listProjectDomains, type ProjectDomain, productionHost, tokenExpiry } from "@/lib/providers/vercel";
import { activeCount, withMonitorLock } from "@/lib/data/monitors-db";
import { MAX_MONITORS, overLimitText, resumeIds } from "@/lib/monitors";
import { badgeOf, isFresh, planSync, type SyncBadge, type SyncKind, syncKind, syncRowSub } from "@/lib/sync";

// `alias`: a database's db-a letter, added by the Sync action (privacy); the dialog shows it instead of the name.
export type SyncRow = { id: string; name: string; sub: string; monitored: boolean; fresh: boolean; badge: SyncBadge; alias?: string };

async function loadAccount(accountId: string) {
  const [account] = await db().select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!account) return null;
  const token = openOrNull({ ciphertext: account.credentialCiphertext, iv: account.credentialIv }, serverEnv().OPS_ENCRYPTION_KEY);
  return { account, token, problem: credentialProblem(token) };
}

// Only the account's own kind (SYNC_KIND): other kinds under the same account aren't Sync's to list or to untick.
export async function listSyncRows(accountId: string, kind: SyncKind): Promise<SyncRow[]> {
  const now = new Date();
  const rows = await db().select().from(resources)
    .where(and(eq(resources.accountId, accountId), eq(resources.kind, kind), isNull(resources.goneAt)))
    .orderBy(resources.name).limit(500);
  return rows.map((r) => ({ id: r.id, name: r.name, sub: syncRowSub(r.kind, r.meta), monitored: r.monitored, fresh: isFresh(r, now), badge: badgeOf(r.kind) }));
}

// Keeps monitors in step with the ticks: pauses those of unwatched or gone apps, resumes those of watched ones (except
// the ones the owner paused on the Uptime page), and creates the default monitor (production domain at "/") for
// watched apps that have none. Pausing needs no token; only looking up the production host does, so without one the
// new monitor uses the project's vercel.app address.
// The 20-monitor cap applies here too (final review I3): resumes and new default monitors that don't fit are left
// paused with the owner's flag (so Sync doesn't flip them back, and Uptime offers Resume), counted under the same
// advisory lock as Add and Resume. Returns how many apps were left over the limit.
export async function syncMonitors(accountId: string, token: string | null): Promise<number> {
  const apps = await db().select().from(resources).where(and(eq(resources.accountId, accountId), eq(resources.kind, "app")));
  const watched = apps.filter((a) => a.monitored && !a.goneAt);
  const unwatched = apps.filter((a) => !a.monitored || a.goneAt);
  if (unwatched.length) await db().update(monitors).set({ paused: true, updatedAt: new Date() }).where(inArray(monitors.resourceId, unwatched.map((a) => a.id)));
  if (!watched.length) return 0;
  const all = await db().select({ id: monitors.id, resourceId: monitors.resourceId, paused: monitors.paused, ownerPaused: monitors.ownerPaused, kind: monitors.kind })
    .from(monitors).where(inArray(monitors.resourceId, watched.map((a) => a.id)));
  // U3: heartbeats have their own cap, counted over every heartbeat row paused or not, so Sync resumes them outright.
  // Only the HTTP checks share the 20-monitor room below.
  const heartbeats = resumeIds(all.filter((m) => m.kind === "heartbeat"));
  if (heartbeats.length) await db().update(monitors).set({ paused: false, updatedAt: new Date() }).where(inArray(monitors.id, heartbeats));
  const mons = all.filter((m) => m.kind !== "heartbeat");
  const resume = resumeIds(mons);
  const existing = new Set(all.map((m) => m.resourceId)); // an app with only a heartbeat left keeps it that way (deleteBlock)
  // Network lookups first: the lock's transaction holds the only pooled connection.
  const fresh: { appId: string; url: string }[] = [];
  for (const app of watched.filter((a) => !existing.has(a.id))) {
    const teamId = String(app.meta.teamId ?? "");
    const stored = typeof app.meta.primaryDomain === "string" && app.meta.primaryDomain ? app.meta.primaryDomain : null;
    const host = stored ? { ok: true as const, data: stored } : token ? await productionHost(token, teamId, app.externalId, app.name) : null;
    fresh.push({ appId: app.id, url: `https://${host?.ok ? host.data : `${app.name}.vercel.app`}/` });
  }
  if (!resume.length && !fresh.length) return 0;
  return withMonitorLock(async (c) => {
    let room = Math.max(0, MAX_MONITORS - await activeCount(c));
    const over = new Set<string>();
    const resumeNow = resume.slice(0, room);
    const leftOver = resume.slice(resumeNow.length);
    room -= resumeNow.length;
    const now = new Date();
    if (resumeNow.length) await c.update(monitors).set({ paused: false, updatedAt: now }).where(inArray(monitors.id, resumeNow));
    if (leftOver.length) {
      await c.update(monitors).set({ paused: false, ownerPaused: true, updatedAt: now }).where(inArray(monitors.id, leftOver));
      for (const m of mons.filter((x) => leftOver.includes(x.id))) over.add(m.resourceId);
    }
    for (const n of fresh) {
      const fits = room > 0;
      if (fits) room -= 1;
      else over.add(n.appId);
      await c.insert(monitors).values({ resourceId: n.appId, url: n.url, ownerPaused: !fits }).onConflictDoNothing();
    }
    return over.size;
  });
}

// Watchbell 1.2.1: the project's domains and the one production is served on, merged into the app's meta (Sync and the
// collector's 6-hourly `domains` task), so a monitor still on an old domain reads as moved, not down (lib/domain-move.ts).
export async function saveAppDomains(appId: string, appName: string, meta: Record<string, unknown>, list: ProjectDomain[]): Promise<void> {
  const aliases = Array.isArray(meta.productionAliases) ? meta.productionAliases.filter((x): x is string => typeof x === "string") : [];
  const patch = appDomainsMeta(list, appName, aliases, meta); // meta: the old domains become pastDomains when they go
  await db().update(resources).set({ meta: sql`${resources.meta} || ${JSON.stringify(patch)}::jsonb` }).where(eq(resources.id, appId));
}

// The stored domain keys survive a Sync's meta rewrite (discovery doesn't read domains); refreshAppDomains renews them.
export function keepDomainKeys(old: Record<string, unknown> | undefined): Record<string, unknown> {
  return old && typeof old.primaryDomain === "string" ? { domains: old.domains, primaryDomain: old.primaryDomain, pastDomains: old.pastDomains ?? [] } : {};
}

// Reads every watched app's domains after a Vercel Sync (outside the transaction: network calls). A failed read keeps
// what was stored; the collector's next `domains` run tries again.
export async function refreshAppDomains(accountId: string, token: string): Promise<void> {
  const apps = await db().select({ id: resources.id, name: resources.name, externalId: resources.externalId, meta: resources.meta, monitored: resources.monitored, goneAt: resources.goneAt })
    .from(resources).where(and(eq(resources.accountId, accountId), eq(resources.kind, "app")));
  for (const app of apps.filter((a) => a.monitored && !a.goneAt)) {
    const list = await listProjectDomains(token, String(app.meta.teamId ?? ""), app.externalId);
    if (list.ok) await saveAppDomains(app.id, app.name, app.meta, list.data);
    else if (list.kind === "auth" || list.status === 429) return;
  }
}

// Zones are what a Cloudflare Sync lists. Like apps: matched on the zone id, new ones watched only with "Watch new
// ones automatically", vanished ones marked gone (their snapshot stays until the account is removed).
export async function upsertZones(accountId: string, watchNew: boolean, zones: CfZone[], now: Date): Promise<void> {
  const existing = (await db().select({ id: resources.id, externalId: resources.externalId, monitored: resources.monitored })
    .from(resources).where(and(eq(resources.accountId, accountId), eq(resources.kind, "zone"))))
    .map((r) => ({ ...r, teamId: null }));
  const plan = planSync(existing, zones.map((z) => ({ externalId: z.id, name: z.name, meta: { status: z.status, accountId: z.accountId, accountName: z.accountName } })), { watchNew });
  await db().transaction(async (tx) => {
    for (const u of plan.update) await tx.update(resources).set({ name: u.name, meta: u.meta, lastSeenAt: now, goneAt: null, updatedAt: now }).where(eq(resources.id, u.id));
    if (plan.insert.length) {
      await tx.insert(resources).values(plan.insert.map((i) => ({ accountId, kind: "zone" as const, externalId: i.externalId, name: i.name, meta: i.meta, monitored: i.monitored })))
        .onConflictDoNothing({ target: [resources.accountId, resources.kind, resources.externalId] });
    }
    if (plan.gone.length) await tx.update(resources).set({ goneAt: now, updatedAt: now }).where(and(inArray(resources.id, plan.gone), isNull(resources.goneAt)));
  });
}

async function syncCloudflare(accountId: string, token: string, watchNew: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const zones = await listZones(token);
  if (!zones.ok) {
    const change = statusAfterTest({ ok: false, kind: zones.kind === "scope" ? "auth" : zones.kind, error: zones.error });
    if (change) await db().update(accounts).set({ ...change, updatedAt: new Date() }).where(eq(accounts.id, accountId));
    return { ok: false, error: zones.error };
  }
  const now = new Date();
  await upsertZones(accountId, watchNew, zones.data, now);
  const expiry = await tokenStatus(token);
  await db().update(accounts).set({ lastSyncAt: now, status: "ok", lastError: null, updatedAt: now, ...(expiry.ok ? { expiresAt: expiry.data.expiresAt } : {}) })
    .where(eq(accounts.id, accountId));
  return { ok: true };
}

type Found = { externalId: string; name: string; meta: Record<string, unknown> };
type Discovery = { ok: true; found: Found[]; skippedTeams: string[]; skippedTeamIds: string[] } | { ok: false; kind: "auth" | "transient" | "format"; error: string };

// Read-only listing per provider. A failure is a failure, never an empty list: an empty list would mark everything gone.
// Cloudflare is not here: its zones go through syncCloudflare / upsertZones.
async function discover(provider: Exclude<Provider, "cloudflare">, credential: string): Promise<Discovery> {
  const fail = (f: { kind: string; error: string }): Discovery => ({ ok: false, kind: f.kind === "auth" || f.kind === "scope" ? "auth" : f.kind === "format" ? "format" : "transient", error: f.error });
  if (provider === "vercel") {
    const r = await discoverVercel(credential);
    if (!r.ok) return { ok: false, kind: r.kind, error: r.error };
    return { ok: true, found: r.data.apps, skippedTeams: r.data.skippedTeams, skippedTeamIds: r.data.skippedTeamIds };
  }
  if (provider === "supabase") {
    const r = await listSupabaseProjects(credential);
    if (!r.ok) return fail(r);
    return { ok: true, skippedTeams: [], skippedTeamIds: [], found: r.data.filter((p) => p.status !== "REMOVED").map((p) => ({
      externalId: p.ref, name: p.name, meta: { orgSlug: p.orgSlug, region: p.region, pgVersion: p.pgVersion, createdAt: p.createdAt, status: p.status },
    })) };
  }
  if (provider === "neon") {
    const r = await discoverNeon(credential);
    if (!r.ok) return fail(r);
    return { ok: true, skippedTeams: [], skippedTeamIds: [], found: r.data.map((p) => ({ externalId: p.id, name: p.name, meta: { orgId: p.orgId, region: p.region, pgVersion: p.pgVersion, createdAt: p.createdAt } })) };
  }
  // Stage 8: a Turso database is matched on its DbId; its organization and group go in meta (the collector reads per org).
  if (provider === "turso") {
    const r = await discoverTurso(credential);
    if (!r.ok) return fail(r);
    return { ok: true, skippedTeams: [], skippedTeamIds: [], found: r.data.map((d) => ({ externalId: d.id, name: d.name, meta: { org: d.org, group: d.group, region: d.primaryRegion } })) };
  }
  if (provider === "upstash") {
    const cred = parseUpstashCred(credential);
    if (!cred) return { ok: false, kind: "format", error: "The stored Upstash credential can't be read. Replace it." };
    const r = await listUpstashRedis(cred);
    if (!r.ok) return fail(r);
    return { ok: true, skippedTeams: [], skippedTeamIds: [], found: r.data.map((d) => ({ externalId: d.id, name: d.name, meta: { region: d.region, type: d.type } })) };
  }
  const sa = parseServiceAccount(credential);
  if (!sa) return { ok: false, kind: "format", error: "The stored service account can't be read. Replace the credential." };
  const token = await googleAccessToken(sa);
  if (!token.ok) return fail(token);
  const r = await discoverFirebase(sa, token.data);
  if (!r.ok) return fail(r);
  return { ok: true, skippedTeams: [], skippedTeamIds: [], found: r.data.map((p) => ({ externalId: p.projectId, name: p.displayName, meta: { projectId: p.projectId } })) };
}

export async function syncAccount(accountId: string): Promise<{ ok: true; rows: SyncRow[]; skippedTeams: string[]; overLimit: string | null } | { ok: false; error: string }> {
  const loaded = await loadAccount(accountId);
  if (!loaded) return { ok: false, error: "That account no longer exists." };
  const { account, token, problem } = loaded;
  const kind = syncKind(account.provider);
  if (!kind) return { ok: false, error: "Sync for this provider arrives in a later stage." };
  if (problem || !token) return { ok: false, error: problem ?? "The credential can't be read." };
  if (account.provider === "cloudflare") {
    const r = await syncCloudflare(accountId, token, account.watchNew);
    return r.ok ? { ok: true, rows: await listSyncRows(accountId, kind), skippedTeams: [], overLimit: null } : r;
  }

  const found = await discover(account.provider as Exclude<Provider, "cloudflare">, token);
  if (!found.ok) {
    const change = statusAfterTest({ ok: false, kind: found.kind, error: found.error });
    if (change) await db().update(accounts).set({ ...change, updatedAt: new Date() }).where(eq(accounts.id, accountId));
    return { ok: false, error: found.error };
  }

  const existing = (await db().select({ id: resources.id, externalId: resources.externalId, monitored: resources.monitored, meta: resources.meta })
    .from(resources).where(and(eq(resources.accountId, accountId), eq(resources.kind, kind))))
    .map((r) => ({ id: r.id, externalId: r.externalId, monitored: r.monitored, teamId: typeof r.meta.teamId === "string" ? r.meta.teamId : null, meta: r.meta }));
  const oldMeta = new Map(existing.map((r) => [r.id, r.meta]));
  const plan = planSync(existing, found.found, { watchNew: account.watchNew, keepTeamIds: found.skippedTeamIds });
  // A network call: keep it out of the transaction, which holds the only pooled connection.
  const expiry = account.provider === "vercel" ? await tokenExpiry(token) : null;
  const now = new Date();
  await db().transaction(async (tx) => {
    for (const u of plan.update) {
      await tx.update(resources).set({ name: u.name, meta: { ...u.meta, ...keepDomainKeys(oldMeta.get(u.id)) }, lastSeenAt: now, goneAt: null, updatedAt: now }).where(eq(resources.id, u.id));
    }
    if (plan.insert.length) {
      await tx.insert(resources).values(plan.insert.map((i) => ({ accountId, kind, externalId: i.externalId, name: i.name, meta: i.meta, monitored: i.monitored })))
        .onConflictDoNothing({ target: [resources.accountId, resources.kind, resources.externalId] }); // an overlapping sync may have inserted it first
    }
    if (plan.gone.length) await tx.update(resources).set({ goneAt: now, updatedAt: now }).where(and(inArray(resources.id, plan.gone), isNull(resources.goneAt)));
    await tx.update(accounts).set({
      lastSyncAt: now, status: "ok", lastError: null, updatedAt: now,
      ...(expiry?.ok ? { expiresAt: expiry.data } : {}),
    }).where(eq(accounts.id, accountId));
  });
  if (account.provider === "vercel") await refreshAppDomains(accountId, token);
  const over = account.provider === "vercel" ? await syncMonitors(accountId, token) : 0;
  return { ok: true, rows: await listSyncRows(accountId, kind), skippedTeams: found.skippedTeams, overLimit: overLimitText(over) };
}

export async function saveSelection(accountId: string, selectedIds: string[], watchNew: boolean): Promise<{ ok: true; on: number; total: number; overLimit: string | null } | { ok: false; error: string }> {
  const loaded = await loadAccount(accountId);
  if (!loaded) return { ok: false, error: "That account no longer exists." };
  const kind = syncKind(loaded.account.provider);
  if (!kind) return { ok: false, error: "Sync for this provider arrives in a later stage." };
  const scope = and(eq(resources.accountId, accountId), eq(resources.kind, kind), isNull(resources.goneAt));
  await db().transaction(async (tx) => {
    const now = new Date();
    if (selectedIds.length) {
      await tx.update(resources).set({ monitored: true, updatedAt: now }).where(and(scope, inArray(resources.id, selectedIds)));
      await tx.update(resources).set({ monitored: false, updatedAt: now }).where(and(scope, notInArray(resources.id, selectedIds)));
    } else {
      await tx.update(resources).set({ monitored: false, updatedAt: now }).where(scope);
    }
    await tx.update(accounts).set({ watchNew, updatedAt: now }).where(eq(accounts.id, accountId));
  });
  const over = loaded.account.provider === "vercel" ? await syncMonitors(accountId, loaded.token) : 0;
  const rows = await listSyncRows(accountId, kind);
  return { ok: true, on: rows.filter((r) => r.monitored).length, total: rows.length, overLimit: overLimitText(over) };
}
