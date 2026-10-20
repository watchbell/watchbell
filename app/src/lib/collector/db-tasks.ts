import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, links, resources, snapshots } from "@/db/schema";
import { statusAfterTest } from "@/lib/accounts";
import { openOrNull } from "@/lib/crypto";
import { recordEvents } from "@/lib/data/events-write";
import { autoRestoreHook } from "@/lib/data/keep-active-db";
import { classifyFailure, databaseEvent, goodState } from "@/lib/databases/events";
import { firestoreState, quotaDayStart } from "@/lib/databases/firebase";
import { neonProjectState } from "@/lib/databases/neon";
import { readData, supabaseData } from "@/lib/databases/snapshot-data";
import { lastTraffic, sizeDue, supabaseState } from "@/lib/databases/supabase";
import { serverEnv } from "@/lib/env";
import type { DbKind } from "@/lib/links";
import { authUserCount, firestoreOps, firestorePing } from "@/lib/providers/firebase";
import { googleAccessToken, parseServiceAccount } from "@/lib/providers/google";
import type { FetchOpts, Failure } from "@/lib/providers/http";
import { getNeonProject, listBranches, listEndpoints } from "@/lib/providers/neon";
import { apiCounts, databaseSize, listProjects, orgPlan, serviceHealth } from "@/lib/providers/supabase";
import type { State } from "@/lib/status";
import { mapLimit } from "./http-check";
import type { NewEvent } from "./rules";

// Database reads for the collector (spec §7.2–7.4, §9.2). Read-only: no call here changes anything at a provider, and
// nothing connects to a monitored database. The only POST that reaches one is the daily read-only size query, which
// runs only for a project already in use (D1).
export type Ctx = { now: Date; deadline: number; errors: string[] };
type Snap = typeof snapshots.$inferSelect;
type Res = typeof resources.$inferSelect;
type Acc = typeof accounts.$inferSelect;
export type Item = { r: Res; s: Snap | null };
// Stage 8 adds Turso, Upstash and the Cloudflare account (for D1): their task (extra-db-tasks.ts) reuses the helpers below.
type Provider = "supabase" | "neon" | "firebase" | "turso" | "upstash" | "cloudflare";

// Thrown, not returned: runCollector then leaves the task due, so the rest runs on the next minute.
const OUT_OF_TIME = "skipped the rest, time budget used";
export const CALL_MS = 5_000; // one provider call's usual timeout
const MARGIN_MS = 500; // what the run keeps for its own writes after the last call
const MIN_CALL_MS = 250; // not worth starting a call with less than this left

// The options for the next provider call: the usual 5 s, but never longer than the run has left (minus a margin), so a
// slow provider can't carry the run past the function's time limit before it has written its last-run time. Throws
// when too little is left to start anything.
export function within(ctx: Ctx): FetchOpts {
  const left = ctx.deadline - Date.now() - MARGIN_MS;
  if (left < MIN_CALL_MS) throw new Error(OUT_OF_TIME);
  return { timeoutMs: Math.min(CALL_MS, left) };
}

// mapLimit that starts no item once the run's time is up. Skipped items come back undefined, so the caller can save
// what finished and then call finish() to leave the task due.
export async function eachWithin<T, R>(ctx: Ctx, items: T[], fn: (it: T, o: FetchOpts) => Promise<R>): Promise<{ out: (R | undefined)[]; skipped: boolean }> {
  let skipped = false;
  const out = await mapLimit(items, 3, async (it): Promise<R | undefined> => {
    let o: FetchOpts;
    try { o = within(ctx); } catch { skipped = true; return undefined; }
    return fn(it, o);
  });
  return { out, skipped };
}

export function finish(skipped: boolean): void {
  if (skipped) throw new Error(OUT_OF_TIME);
}

export async function accountsOf(provider: Provider): Promise<{ acc: Acc; credential: string | null }[]> {
  const list = await db().select().from(accounts).where(and(eq(accounts.provider, provider), eq(accounts.status, "ok")));
  const key = serverEnv().OPS_ENCRYPTION_KEY;
  return list.map((acc) => ({ acc, credential: openOrNull({ ciphertext: acc.credentialCiphertext, iv: acc.credentialIv }, key) }));
}

export function watchedOf(accountId: string, kind: DbKind): Promise<Item[]> {
  return db().select({ r: resources, s: snapshots }).from(resources)
    .leftJoin(snapshots, eq(snapshots.resourceId, resources.id))
    .where(and(eq(resources.accountId, accountId), eq(resources.kind, kind), eq(resources.monitored, true), isNull(resources.goneAt)))
    .limit(100);
}

const merged = (patch: Record<string, unknown>) => sql`${snapshots.data} || ${JSON.stringify(patch)}::jsonb`;

// Only the status tasks set `state`. D6: "unknown" keeps data and state_since (so a paused project's restore deadline
// survives an outage) and remembers the last good state; events compare good states only.
export async function writeState(item: Item, next: { state: State; label: string; patch: Record<string, unknown> }, now: Date): Promise<NewEvent | null> {
  const prevGood = goodState(item.s ? { state: item.s.state, data: item.s.data } : null);
  const unknown = next.state === "unknown";
  const patch = unknown ? (prevGood ? { lastGoodState: prevGood } : {}) : { ...next.patch, lastGoodState: next.state };
  const changed = !unknown && prevGood !== next.state;
  await db().insert(snapshots).values({ resourceId: item.r.id, state: next.state, data: patch, collectedAt: now, stateSince: now })
    .onConflictDoUpdate({
      target: snapshots.resourceId,
      set: { state: next.state, data: merged(patch), ...(unknown ? {} : { collectedAt: now }), ...(changed ? { stateSince: now } : {}) },
    });
  return unknown ? null : databaseEvent({ kind: item.r.kind as DbKind, resourceId: item.r.id, prev: prevGood, next: next.state, label: next.label, at: now });
}

// Slower reads only add fields; they never change the state.
export async function mergeData(item: Item, patch: Record<string, unknown>): Promise<void> {
  await db().update(snapshots).set({ data: merged(patch) }).where(eq(snapshots.resourceId, item.r.id));
}

// Through recordEvents (R2): each event carries its reason, and a repeat within the hour bumps the count.
export const saveEvents = (list: (NewEvent | null)[]): Promise<void> => recordEvents(list);

export async function accountDown(provider: Provider, acc: Acc, items: Item[], f: Failure, ctx: Ctx): Promise<void> {
  if (classifyFailure(f, true) === "auth") {
    const change = statusAfterTest({ ok: false, kind: "auth", error: f.error });
    if (change) await db().update(accounts).set({ ...change, updatedAt: ctx.now }).where(eq(accounts.id, acc.id));
  }
  for (const it of items) await writeState(it, { state: "unknown", label: "Unknown", patch: {} }, ctx.now);
  ctx.errors.push(`${provider}/${acc.label}: ${f.error}`);
}

const iso = (d: Date) => d.toISOString();

// D7: the apps whose linked database is paused (or was, before the provider stopped answering). Only a database the
// console still watches counts: an unticked or gone one gets no more updates, so its last state would hold the app
// degraded for good.
export async function appsWithPausedDatabase(appIds: string[]): Promise<Set<string>> {
  if (!appIds.length) return new Set();
  const rows = await db().select({ app: links.fromResourceId, state: snapshots.state, data: snapshots.data }).from(links)
    .innerJoin(resources, eq(resources.id, links.toResourceId))
    .innerJoin(snapshots, eq(snapshots.resourceId, resources.id))
    .where(and(eq(links.kind, "uses_db"), inArray(links.fromResourceId, appIds), eq(resources.monitored, true), isNull(resources.goneAt)));
  return new Set(rows.filter((l) => l.state === "paused" || (l.state === "unknown" && l.data.lastGoodState === "paused")).map((l) => l.app));
}

// Every 5 min: one project list per account (spec §15: "single call for all projects per account").
export async function taskSupabase(ctx: Ctx): Promise<void> {
  for (const { acc, credential } of await accountsOf("supabase")) {
    within(ctx);
    if (!credential) { ctx.errors.push(`supabase/${acc.label}: credential can't be read`); continue; }
    const items = await watchedOf(acc.id, "supabase_project");
    if (!items.length) continue;
    const list = await listProjects(credential, within(ctx));
    if (!list.ok) { await accountDown("supabase", acc, items, list, ctx); continue; }
    const byRef = new Map(list.data.map((p) => [p.ref, p]));
    const evs: (NewEvent | null)[] = [];
    for (const it of items) {
      const p = byRef.get(it.r.externalId);
      if (!p) { evs.push(await writeState(it, { state: "off", label: "Not found", patch: { status: "REMOVED" } }, ctx.now)); continue; }
      const st = supabaseState(p.status);
      const prevGood = goodState(it.s ? { state: it.s.state, data: it.s.data } : null);
      const patch: Record<string, unknown> = { status: p.status, region: p.region, pgVersion: p.pgVersion, orgSlug: p.orgSlug };
      // D4: the restore deadline counts from when we saw the pause; a project already paused at first sight says so.
      if (st.state === "paused" && prevGood !== "paused") patch.pausedBeforeSeen = prevGood === null;
      evs.push(await writeState(it, { state: st.state, label: st.label, patch }, ctx.now));
    }
    await saveEvents(evs);
    // Stage 6 A8: Auto-restore, from the statuses just read (every project the token sees, for the free slots). It
    // never fails the status task: a problem is one short line.
    const ids = new Map(items.map((it) => [it.r.externalId, it.r.id]));
    const statuses = list.data.map((p) => ({ resourceId: ids.get(p.ref) ?? null, accountId: acc.id, status: p.status, orgSlug: p.orgSlug }));
    await autoRestoreHook(ctx.now, statuses, ctx.deadline).catch(() => {
      console.warn("auto-restore failed");
      ctx.errors.push("auto-restore failed");
    });
  }
}

// Hourly: service health and the last API traffic (active projects only), plus each org's plan for the free slots.
export async function taskSupabaseUsage(ctx: Ctx): Promise<void> {
  for (const { acc, credential } of await accountsOf("supabase")) {
    within(ctx);
    if (!credential) continue;
    const items = await watchedOf(acc.id, "supabase_project");
    if (!items.length) continue;
    const data = new Map(items.map((it) => [it.r.id, readData(supabaseData, it.s?.data)]));
    const plans = new Map<string, boolean | null>();
    for (const org of new Set([...data.values()].map((d) => d.orgSlug).filter((o): o is string => !!o))) {
      const p = await orgPlan(credential, org, within(ctx));
      plans.set(org, p.ok && p.data !== null ? p.data === "free" : null);
      if (!p.ok && p.kind !== "scope") ctx.errors.push(`supabase/${acc.label} plan: ${p.error}`);
    }
    const { skipped } = await eachWithin(ctx, items, async (it, o) => {
      const d = data.get(it.r.id)!;
      const patch: Record<string, unknown> = { freeOrg: d.orgSlug ? plans.get(d.orgSlug) ?? null : null };
      if ((d.status ?? "").startsWith("ACTIVE_")) {
        const [health, counts] = await Promise.all([serviceHealth(credential, it.r.externalId, o), apiCounts(credential, it.r.externalId, o)]);
        if (health.ok) Object.assign(patch, { health: health.data.map(({ name, status }) => ({ name, status })), healthAt: iso(ctx.now), healthError: null });
        else if (classifyFailure(health, false) === "column") patch.healthError = health.error;
        else ctx.errors.push(`supabase/${it.r.name} health: ${health.error}`);
        if (counts.ok) Object.assign(patch, { lastTrafficAt: lastTraffic(counts.data)?.toISOString() ?? null, trafficAt: iso(ctx.now), trafficError: null });
        else if (classifyFailure(counts, false) === "column") patch.trafficError = counts.error;
        else ctx.errors.push(`supabase/${it.r.name} traffic: ${counts.error}`);
      }
      await mergeData(it, patch);
    });
    finish(skipped);
  }
}

// Every 5 min: usage, computes and branches per watched project, 3 calls each, all through the API (never Postgres).
export async function taskNeon(ctx: Ctx): Promise<void> {
  for (const { acc, credential } of await accountsOf("neon")) {
    within(ctx);
    if (!credential) { ctx.errors.push(`neon/${acc.label}: credential can't be read`); continue; }
    const items = await watchedOf(acc.id, "neon_project");
    if (!items.length) continue;
    const { out: results, skipped } = await eachWithin(ctx, items, (it, o) => Promise.all([
      getNeonProject(credential, it.r.externalId, o), listEndpoints(credential, it.r.externalId, o), listBranches(credential, it.r.externalId, o),
    ]));
    const rejected = results.flat().find((r): r is Failure => r !== undefined && !r.ok && r.kind === "auth");
    if (rejected) { await accountDown("neon", acc, items, rejected, ctx); continue; }
    const evs: (NewEvent | null)[] = [];
    for (const [i, it] of items.entries()) {
      const got = results[i];
      if (!got) continue; // not started: the run ran out of time
      const [p, eps, brs] = got;
      if (!p.ok || !eps.ok || !brs.ok) {
        const f = [p, eps, brs].find((x): x is Failure => !x.ok)!;
        if (f.kind === "missing") evs.push(await writeState(it, { state: "off", label: "Not found", patch: {} }, ctx.now));
        else {
          await writeState(it, { state: "unknown", label: "Unknown", patch: {} }, ctx.now);
          ctx.errors.push(`neon/${it.r.name}: ${f.error}`);
        }
        continue;
      }
      const st = neonProjectState({ endpoints: eps.data, computeSeconds: p.data.computeSeconds });
      evs.push(await writeState(it, {
        state: st.state, label: st.label,
        patch: {
          region: p.data.region, pgVersion: p.data.pgVersion, computeSeconds: p.data.computeSeconds, transferBytes: p.data.transferBytes, activeSeconds: p.data.activeSeconds,
          periodStart: p.data.periodStart, periodEnd: p.data.periodEnd, endpoints: eps.data, branches: brs.data,
        },
      }, ctx.now));
    }
    await saveEvents(evs);
    finish(skipped);
  }
}

// Every 5 min: one Firestore document read per project (288 a day of the 50k).
export async function taskFirebase(ctx: Ctx): Promise<void> {
  for (const { acc, credential } of await accountsOf("firebase")) {
    within(ctx);
    const sa = credential ? parseServiceAccount(credential) : null;
    if (!sa) { ctx.errors.push(`firebase/${acc.label}: credential can't be read`); continue; }
    const items = await watchedOf(acc.id, "firestore");
    if (!items.length) continue;
    const token = await googleAccessToken(sa, within(ctx));
    if (!token.ok) { await accountDown("firebase", acc, items, token, ctx); continue; }
    const { out: pings, skipped } = await eachWithin(ctx, items, (it, o) => firestorePing(token.data, it.r.externalId, o));
    const evs: (NewEvent | null)[] = [];
    for (const [i, it] of items.entries()) {
      const p = pings[i];
      if (!p) continue; // not started: the run ran out of time
      const st = firestoreState(p);
      if (st.state === "unknown" && !p.ok) ctx.errors.push(`firebase/${it.r.name}: ${p.error}`);
      // pingKind and pingReason let the page name the failure (needs datastore.viewer, API off, quota) from one rule.
      const patch = p.ok ? { latencyMs: p.data.latencyMs, pingError: null, pingReason: null, pingKind: null } : { pingError: p.error, pingReason: p.reason ?? null, pingKind: p.kind };
      evs.push(await writeState(it, { ...st, patch }, ctx.now));
    }
    await saveEvents(evs);
    finish(skipped);
  }
}

// Hourly: reads, writes and deletes since midnight Pacific (when the free quota resets), from Cloud Monitoring.
export async function taskFirebaseUsage(ctx: Ctx): Promise<void> {
  for (const { acc, credential } of await accountsOf("firebase")) {
    within(ctx);
    const sa = credential ? parseServiceAccount(credential) : null;
    if (!sa) continue;
    const items = (await watchedOf(acc.id, "firestore")).filter((it) => it.s?.state !== "off");
    if (!items.length) continue;
    const token = await googleAccessToken(sa, within(ctx));
    if (!token.ok) { ctx.errors.push(`firebase/${acc.label}: ${token.error}`); continue; }
    const from = quotaDayStart(ctx.now);
    const { skipped } = await eachWithin(ctx, items, async (it, o) => {
      const r = await firestoreOps(token.data, it.r.externalId, from, ctx.now, o);
      if (r.ok) await mergeData(it, { ...r.data, opsAt: iso(ctx.now), opsError: null });
      else if (classifyFailure(r, false) === "column") {
        await mergeData(it, {
          reads: null, writes: null, deletes: null, opsAt: iso(ctx.now),
          // On Spark, Cloud Monitoring's timeSeries answers 403 "requires billing" (checked live on 13 Oct 2026): usage
          // can't be read on the free plan at all, which is not a missing role.
          opsError: /requires billing/i.test(r.message ?? "") ? "Not available on Spark: Firestore usage needs billing (Blaze plan)"
            : r.reason === "SERVICE_DISABLED" ? "Not readable: the Cloud Monitoring API is off in this project" : "Not readable: the service account needs monitoring.viewer",
        });
      } else ctx.errors.push(`firebase/${it.r.name} usage: ${r.error}`);
    });
    finish(skipped);
  }
}

// Daily (/api/daily, step "databases"): Supabase database size (D1-gated) and Firebase Auth user counts.
export async function taskDatabasesDaily(ctx: Ctx): Promise<void> {
  // Supabase gets two thirds of the time, so a slow provider can't use up the Firebase user counts' share.
  const share = Date.now() + Math.max(0, ctx.deadline - Date.now()) * 2 / 3;
  const first = await settle(() => dailySupabase({ ...ctx, deadline: share }));
  const second = await settle(() => dailyFirebase(ctx));
  if (first) throw first;
  if (second) throw second;
}

export async function settle(fn: () => Promise<void>): Promise<Error | null> {
  try { await fn(); return null; } catch (e) { return e instanceof Error ? e : new Error(String(e)); }
}

async function dailySupabase(ctx: Ctx): Promise<void> {
  for (const { acc, credential } of await accountsOf("supabase")) {
    within(ctx);
    if (!credential) continue;
    for (const it of await watchedOf(acc.id, "supabase_project")) {
      const d = readData(supabaseData, it.s?.data);
      const due = sizeDue({
        status: d.status ?? "", lastTrafficAt: d.lastTrafficAt ? new Date(d.lastTrafficAt) : null, sizeAt: d.sizeAt ? new Date(d.sizeAt) : null, now: ctx.now,
      });
      if (!due) continue;
      const r = await databaseSize(credential, it.r.externalId, within(ctx));
      if (r.ok) await mergeData(it, { sizeBytes: r.data, sizeAt: iso(ctx.now), sizeError: null });
      else if (classifyFailure(r, false) === "column") await mergeData(it, { sizeError: r.error });
      else ctx.errors.push(`supabase/${it.r.name} size: ${r.error}`);
    }
  }
}

async function dailyFirebase(ctx: Ctx): Promise<void> {
  for (const { acc, credential } of await accountsOf("firebase")) {
    within(ctx);
    const sa = credential ? parseServiceAccount(credential) : null;
    if (!sa) continue;
    const items = (await watchedOf(acc.id, "firestore")).filter((it) => it.s?.state !== "off");
    if (!items.length) continue;
    const token = await googleAccessToken(sa, within(ctx));
    if (!token.ok) { ctx.errors.push(`firebase/${acc.label}: ${token.error}`); continue; }
    const { skipped } = await eachWithin(ctx, items, async (it, o) => {
      const r = await authUserCount(token.data, it.r.externalId, o);
      if (r.ok) await mergeData(it, { authUsers: r.data, authAt: iso(ctx.now), authError: null });
      else if (classifyFailure(r, false) === "column") await mergeData(it, { authError: "Not readable: the service account needs firebaseauth.viewer" });
      else ctx.errors.push(`firebase/${it.r.name} users: ${r.error}`);
    });
    finish(skipped);
  }
}
