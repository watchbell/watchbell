import "server-only";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { checks, monitors, resources } from "@/db/schema";
import { ruleFrom } from "@/lib/body-rule";
import { pathOf } from "@/lib/collector/deploy-sync";
import { checkUrl } from "@/lib/collector/http-check";
import { simulatedCheck } from "@/lib/demo/simulate";
import { same, writeCheckResult } from "@/lib/collector/monitor-write";
import { monitorEvent, nextMonitorState } from "@/lib/collector/rules";
import { RECHECK_AFTER_MS } from "@/lib/collector/schedule";
import { recordEvents } from "@/lib/data/events-write";
import { heartbeatKey, newToken } from "@/lib/heartbeat-token";
import { activeFor } from "@/lib/maintenance";
import { isDemo } from "@/lib/mode";
import {
  checkNowMessage, deleteBlock, heartbeatLimitBlock, type HeartbeatValues, isChecked, lastResultMessage, limitBlock, type MonitorValues, resetsState,
} from "@/lib/monitors";
import type { State } from "@/lib/status";
import { appDomain, hostPath } from "@/lib/view/format";
import { type DayCount, lastDays, UPTIME_DAYS, uptimePct } from "@/lib/view/uptime";
import { PAGE_ROWS } from "@/lib/view/windows";
import { taskHeartbeats } from "./heartbeats-db";
import { listRawWindows } from "./maintenance-db";
import { monitorDays } from "./metrics-db";

// `path` is what a list shows after the app's name: the HTTP check's path, or a heartbeat's name (U3). The token hash
// never leaves this module.
export type MonitorLite = {
  id: string; appId: string; url: string; path: string; state: State; lastStatus: number | null; lastLatencyMs: number | null;
  failStreak: number; paused: boolean; ownerPaused: boolean; lastCheckedAt: Date | null; expectedStatus: number; timeoutMs: number; intervalS: number;
  bodyContains: string | null; jsonPath: string | null; jsonEquals: string | null; lastError: string | null;
  kind: "http" | "heartbeat"; name: string | null; periodS: number | null; graceS: number | null; lastPingAt: Date | null;
  // When the monitor entered its current state (the "Why" popover's "since").
  stateSince?: Date | null;
};

export function toMonitorLite(m: typeof monitors.$inferSelect): MonitorLite {
  const hb = m.kind === "heartbeat";
  return {
    id: m.id, appId: m.resourceId, url: m.url, path: hb ? (m.name ?? "heartbeat") : pathOf(m.url), state: m.state, lastStatus: m.lastStatus, lastLatencyMs: m.lastLatencyMs,
    failStreak: m.failStreak, paused: m.paused, ownerPaused: m.ownerPaused, lastCheckedAt: m.lastCheckedAt,
    expectedStatus: m.expectedStatus, timeoutMs: m.timeoutMs, intervalS: m.intervalS,
    bodyContains: m.bodyContains, jsonPath: m.jsonPath, jsonEquals: m.jsonEquals, lastError: m.lastError,
    kind: hb ? "heartbeat" : "http", name: m.name ?? null, periodS: m.periodS ?? null, graceS: m.graceS ?? null, lastPingAt: m.lastPingAt ?? null, stateSince: m.stateSince ?? null,
  };
}

export type MonitorRow = MonitorLite & { appName: string; appGone: boolean; days: Map<string, DayCount> | undefined; uptime30: number | null };

// Uptime page: every monitor of a watched app, with its 90 days and 30-day uptime. Per app, HTTP checks come before
// heartbeats ('http' sorts after 'heartbeat', hence desc), as in the mockup.
export async function listMonitors(now: Date): Promise<MonitorRow[]> {
  const rows = await db().select({ m: monitors, appName: resources.name, goneAt: resources.goneAt }).from(monitors)
    .innerJoin(resources, eq(resources.id, monitors.resourceId))
    .where(and(eq(resources.kind, "app"), eq(resources.monitored, true)))
    .orderBy(resources.name, desc(monitors.kind), monitors.url).limit(PAGE_ROWS.monitors);
  const days = await monitorDays(rows.map((r) => r.m.id), now);
  return rows.map(({ m, appName, goneAt }) => ({
    ...toMonitorLite(m), appName, appGone: goneAt !== null, days: days.get(m.id), uptime30: uptimePct(lastDays(days.get(m.id), now, UPTIME_DAYS)),
  }));
}

export type Audit = { message: string; detail?: string; resourceId: string | null };
// `token`: a heartbeat's new ping token (Add heartbeat, Show ping URL). It is handed back once for the dialog that shows
// it, and is never stored, logged or put in the audit entry; only its hash is saved (B2).
export type Done = { ok: true; message: string; passed?: boolean; audit?: Audit; token?: string } | { ok: false; error: string };
export type AppOption = { id: string; name: string; domain: string };

const GONE: Done = { ok: false, error: "That monitor no longer exists." };
const DUPLICATE: Done = { ok: false, error: "This app already has a monitor for that address." };
const NOT_WATCHED: Done = { ok: false, error: "That app isn't watched. Tick it in Connections → Sync first." };
// A gone app can't be ticked in Sync, so it gets its own message instead of that advice (M5).
const APP_GONE_MESSAGE = "This app no longer exists at Vercel.";
const APP_GONE: Done = { ok: false, error: APP_GONE_MESSAGE };
const APP_GONE_MESSAGE_SHORT = "The app no longer exists at Vercel";
const ALREADY_RUNNING: Done = { ok: true, message: "Already running." };
const CHANGED: Done = { ok: false, error: "Someone else changed this monitor just now. Reopen it and try again." };
const DUPLICATE_NAME: Done = { ok: false, error: "This app already has a heartbeat with that name." };
const NOT_HEARTBEAT: Done = { ok: false, error: "That monitor isn't a heartbeat." };
const NOT_HTTP: Done = { ok: false, error: "That monitor is a heartbeat. Edit it from its own menu." };
const HEARTBEAT_NO_CHECK: Done = { ok: false, error: "The console doesn't check a heartbeat. It waits for your job's ping." };

const isHeartbeat = (m: { kind?: string | null }) => m.kind === "heartbeat";
// What a toast and the audit trail call a monitor: "web.example.com/api/health", or a heartbeat's name.
const targetOf = (m: { kind?: string | null; name?: string | null; url: string }) => (isHeartbeat(m) ? (m.name ?? "heartbeat") : hostPath(m.url));

// Add monitor → Application select: watched apps with the domain their first monitor checks.
export async function appOptions(): Promise<AppOption[]> {
  const apps = await db().select({ id: resources.id, name: resources.name }).from(resources)
    .where(and(eq(resources.kind, "app"), eq(resources.monitored, true), isNull(resources.goneAt)))
    .orderBy(resources.name).limit(PAGE_ROWS.apps);
  if (!apps.length) return [];
  // A heartbeat's url ("heartbeat:backup-job") names no domain.
  const mons = await db().select({ appId: monitors.resourceId, url: monitors.url }).from(monitors)
    .where(and(inArray(monitors.resourceId, apps.map((a) => a.id)), eq(monitors.kind, "http"))).orderBy(monitors.createdAt);
  return apps.map((a) => ({ ...a, domain: appDomain(a.name, mons.filter((m) => m.appId === a.id).map((m) => m.url)) }));
}

export type Conn = Pick<ReturnType<typeof db>, "select" | "insert" | "update" | "delete">;

// The 20-monitor cap and the "last monitor of a watched app stays" rule are check-then-write, so the writes that
// depend on them run in one transaction behind a transaction-scoped advisory lock (safe on the transaction pooler).
// A waiting writer's next statement then sees what the first one committed.
export async function withMonitorLock<T>(fn: (c: Conn) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ops.monitors'))`);
    return fn(tx);
  });
}

// The 20-monitor cap counts the HTTP checks the collector fetches; heartbeats have their own cap (heartbeatCount).
export async function activeCount(c: Conn = db()): Promise<number> {
  const [r] = await c.select({ n: sql<number>`count(*)::int` }).from(monitors)
    .innerJoin(resources, eq(resources.id, monitors.resourceId))
    .where(and(eq(monitors.kind, "http"), eq(monitors.paused, false), eq(monitors.ownerPaused, false), eq(resources.monitored, true), isNull(resources.goneAt)));
  return r?.n ?? 0;
}

// Every heartbeat row, paused or not (heartbeatLimitBlock), so resuming one never runs into the cap.
export async function heartbeatCount(c: Conn = db()): Promise<number> {
  const [r] = await c.select({ n: sql<number>`count(*)::int` }).from(monitors).where(eq(monitors.kind, "heartbeat"));
  return r?.n ?? 0;
}

async function loadMonitor(id: string) {
  const [row] = await db().select({ m: monitors, watched: resources.monitored, goneAt: resources.goneAt }).from(monitors)
    .innerJoin(resources, eq(resources.id, monitors.resourceId)).where(eq(monitors.id, id)).limit(1);
  return row ?? null;
}

// postgres.js puts the SQLSTATE on the error; newer drizzle wraps it as `cause`.
function pgCode(e: unknown): string | undefined {
  const o = e as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = o?.code ?? o?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

export async function createMonitor(appId: string, v: MonitorValues): Promise<Done> {
  return withMonitorLock(async (c): Promise<Done> => {
    const [app] = await c.select({ id: resources.id, goneAt: resources.goneAt }).from(resources)
      .where(and(eq(resources.id, appId), eq(resources.kind, "app"), eq(resources.monitored, true))).limit(1);
    if (!app) return NOT_WATCHED;
    if (app.goneAt) return APP_GONE;
    const block = limitBlock(await activeCount(c));
    if (block) return { ok: false, error: block };
    const rows = await c.insert(monitors).values({
      resourceId: appId, kind: "http", url: v.url, expectedStatus: v.expectedStatus, timeoutMs: v.timeoutMs,
      bodyContains: v.bodyContains, jsonPath: v.jsonPath, jsonEquals: v.jsonEquals,
    })
      .onConflictDoNothing().returning({ id: monitors.id });
    if (!rows.length) return DUPLICATE;
    return {
      ok: true, message: `Monitoring ${hostPath(v.url)}. First result within a minute.`,
      audit: { message: `Monitor added: ${hostPath(v.url)}`, resourceId: appId },
    };
  });
}

// U3: Add monitor -> Heartbeat. The token is made here, only its hash is stored, and it goes back to the caller once
// (the action turns it into the ping URL for the dialog). The url column is "heartbeat:" + a slug of the name, so the
// (resource_id, url) unique index keeps one heartbeat of each name per app. It waits for its first ping ("unknown").
export async function createHeartbeat(appId: string, v: HeartbeatValues): Promise<Done> {
  const { token, hash } = newToken();
  return withMonitorLock(async (c): Promise<Done> => {
    const [app] = await c.select({ id: resources.id, goneAt: resources.goneAt }).from(resources)
      .where(and(eq(resources.id, appId), eq(resources.kind, "app"), eq(resources.monitored, true))).limit(1);
    if (!app) return NOT_WATCHED;
    if (app.goneAt) return APP_GONE;
    const block = heartbeatLimitBlock(await heartbeatCount(c));
    if (block) return { ok: false, error: block };
    const rows = await c.insert(monitors).values({
      resourceId: appId, kind: "heartbeat", url: heartbeatKey(v.name), name: v.name, tokenHash: hash, periodS: v.periodS, graceS: v.graceS, state: "unknown",
    }).onConflictDoNothing().returning({ id: monitors.id });
    if (!rows.length) return DUPLICATE_NAME;
    return {
      ok: true, message: `Added ${v.name}. It waits for the first ping.`, token,
      audit: { message: `Heartbeat added: ${v.name}`, resourceId: appId },
    };
  });
}

// Edit monitor on a heartbeat: its name, period and grace. The state isn't reset: the next run recomputes it from the
// last ping with the new period and grace (and its compare-and-set drops a run that read the old ones).
export async function updateHeartbeat(id: string, v: HeartbeatValues): Promise<Done> {
  const row = await loadMonitor(id);
  if (!row) return GONE;
  if (!isHeartbeat(row.m)) return NOT_HEARTBEAT;
  if (row.goneAt) return APP_GONE;
  if (!row.watched) return NOT_WATCHED;
  const url = heartbeatKey(v.name);
  const [clash] = await db().select({ id: monitors.id }).from(monitors)
    .where(and(eq(monitors.resourceId, row.m.resourceId), eq(monitors.url, url), ne(monitors.id, id))).limit(1);
  if (clash) return DUPLICATE_NAME;
  let changed: unknown[];
  try {
    changed = await db().update(monitors).set({ name: v.name, url, periodS: v.periodS, graceS: v.graceS, updatedAt: new Date() })
      .where(and(eq(monitors.id, id), eq(monitors.kind, "heartbeat"))).returning({ id: monitors.id });
  } catch (e) {
    if (pgCode(e) === "23505") return DUPLICATE_NAME;
    throw e;
  }
  if (!changed.length) return GONE;
  const renamed = row.m.name !== v.name;
  return {
    ok: true, message: `Saved ${v.name}.`,
    audit: { message: `Heartbeat edited: ${v.name}`, ...(renamed && row.m.name ? { detail: `was ${row.m.name}` } : {}), resourceId: row.m.resourceId },
  };
}

// "Show ping URL": the console can't show the old URL (it keeps only a hash), so it makes a new token and the old one
// stops working at once. The menu asks first.
export async function rotateToken(id: string): Promise<Done> {
  const row = await loadMonitor(id);
  if (!row) return GONE;
  if (!isHeartbeat(row.m)) return NOT_HEARTBEAT;
  const { token, hash } = newToken();
  const done = await db().update(monitors).set({ tokenHash: hash, updatedAt: new Date() })
    .where(and(eq(monitors.id, id), eq(monitors.kind, "heartbeat"))).returning({ id: monitors.id });
  if (!done.length) return GONE;
  const name = targetOf(row.m);
  return {
    ok: true, message: `New ping URL for ${name}. The old one no longer works.`, token,
    audit: { message: `Ping URL replaced: ${name}`, resourceId: row.m.resourceId },
  };
}

// Record a test ping (ok or fail) from the console by monitor id, so the owner can see the state change without a
// terminal. It writes the same columns as the ping route (recordPing) and needs no token, which the console never
// has. The caller's write quota stands in for the per-token limit, and a viewer never reaches this (the action's role
// guard). The collector recomputes the state within a minute.
export async function recordTestPing(id: string, kind: "ok" | "fail", now: Date = new Date()): Promise<Done> {
  const row = await loadMonitor(id);
  if (!row) return GONE;
  if (!isHeartbeat(row.m)) return NOT_HEARTBEAT;
  const done = await db().update(monitors).set({ lastPingAt: now, lastPingKind: kind, updatedAt: now })
    .where(and(eq(monitors.id, id), eq(monitors.kind, "heartbeat"))).returning({ id: monitors.id });
  if (!done.length) return GONE;
  const name = targetOf(row.m);
  const message = `Test ping (${kind}) recorded for ${name}`;
  // Recompute this heartbeat now (maintenance windows included), so the row shows its new state on the refresh that
  // follows the action. If that fails, the next collector run does it within a minute.
  let recomputed = false;
  try {
    const windows = await listRawWindows();
    await taskHeartbeats(new Date(), (monitorId, appId) => activeFor(windows, { monitorId, appId }, new Date()) !== null, true, id);
    recomputed = true;
  } catch {
    console.warn("test ping: recompute failed");
  }
  return { ok: true, message: recomputed ? `${message}.` : `${message}. The state updates within a minute.`, audit: { message, detail: "Test", resourceId: row.m.resourceId } };
}

// Edit monitor (carry-over c: the default monitor's "/" and 200 can be changed). A new address or expected status
// starts the state afresh, so the old fail streak doesn't carry over to what is now being checked.
export async function updateMonitor(id: string, v: MonitorValues): Promise<Done> {
  const row = await loadMonitor(id);
  if (!row) return GONE;
  if (isHeartbeat(row.m)) return NOT_HTTP;
  if (row.goneAt) return APP_GONE;
  if (!row.watched) return NOT_WATCHED;
  const [clash] = await db().select({ id: monitors.id }).from(monitors)
    .where(and(eq(monitors.resourceId, row.m.resourceId), eq(monitors.url, v.url), ne(monitors.id, id))).limit(1);
  if (clash) return DUPLICATE;
  const now = new Date();
  const before = {
    url: row.m.url, expectedStatus: row.m.expectedStatus, timeoutMs: row.m.timeoutMs,
    bodyContains: row.m.bodyContains, jsonPath: row.m.jsonPath, jsonEquals: row.m.jsonEquals,
  };
  const fresh = resetsState(before, v)
    ? { state: "unknown" as const, failStreak: 0, stateSince: now, lastCheckedAt: null, lastStatus: null, lastLatencyMs: null, lastError: null }
    : {};
  // Compare-and-set on what this edit read: a concurrent edit of the address or expected status isn't overwritten
  // unseen. (A collector run or Check now in flight drops its own result when the address changes: monitor-write.ts.)
  let changed: unknown[];
  try {
    changed = await db().update(monitors).set({
      url: v.url, expectedStatus: v.expectedStatus, timeoutMs: v.timeoutMs,
      bodyContains: v.bodyContains, jsonPath: v.jsonPath, jsonEquals: v.jsonEquals, ...fresh, updatedAt: now,
    }).where(and(
      eq(monitors.id, id), eq(monitors.url, row.m.url), eq(monitors.expectedStatus, row.m.expectedStatus),
      same(monitors.bodyContains, row.m.bodyContains), same(monitors.jsonPath, row.m.jsonPath), same(monitors.jsonEquals, row.m.jsonEquals),
    )).returning({ id: monitors.id });
  } catch (e) {
    if (pgCode(e) === "23505") return DUPLICATE; // a concurrent edit or add took the address after the check above
    throw e;
  }
  if (!changed.length) return (await loadMonitor(id)) ? CHANGED : GONE;
  const moved = before.url !== v.url;
  return {
    // Final review M8: an owner-paused monitor isn't checked until it is resumed, so don't promise a check.
    ok: true, message: row.m.ownerPaused ? `Saved ${hostPath(v.url)}. It's checked again once you resume it.` : `Checking ${hostPath(v.url)} from the next run.`,
    audit: { message: `Monitor edited: ${hostPath(v.url)}`, ...(moved ? { detail: `was ${hostPath(before.url)}` } : {}), resourceId: row.m.resourceId },
  };
}

// Carry-over b: the owner's pause is its own flag, which Sync never clears. Resuming starts the state afresh.
// A monitor can also carry Sync's `paused` (its app was unwatched while the owner had paused it). When the app is
// watched, the owner's Resume clears both flags, so it never looks like it did nothing until the next Sync.
export async function setMonitorPaused(id: string, paused: boolean): Promise<Done> {
  const row = await loadMonitor(id);
  if (!row) return GONE;
  const now = new Date();
  const target = targetOf(row.m);
  if (paused) {
    await db().update(monitors).set({ ownerPaused: true, updatedAt: now }).where(eq(monitors.id, id));
    return { ok: true, message: `Paused ${target}. Its history is kept.`, audit: { message: `Monitor paused: ${target}`, resourceId: row.m.resourceId } };
  }
  // Final review M2: Resume only acts on a monitor the owner paused. A stale menu (another tab, the 60 s window) on a
  // running monitor must not reset its state and fail streak, so the write is conditional on owner_paused too.
  if (!row.m.ownerPaused) return ALREADY_RUNNING;
  const watched = row.watched && !row.goneAt;
  return withMonitorLock(async (c): Promise<Done> => {
    // A heartbeat is counted by its own cap whether paused or not, so resuming one needs no count.
    const block = isHeartbeat(row.m) ? null : limitBlock(await activeCount(c), watched ? 1 : 0);
    if (block) return { ok: false, error: block };
    const resumed = await c.update(monitors).set({
      ownerPaused: false, ...(watched ? { paused: false } : {}), state: "unknown", failStreak: 0, stateSince: now, updatedAt: now,
    }).where(and(eq(monitors.id, id), eq(monitors.ownerPaused, true))).returning({ id: monitors.id });
    if (!resumed.length) return (await c.select({ id: monitors.id }).from(monitors).where(eq(monitors.id, id)).limit(1)).length ? ALREADY_RUNNING : GONE;
    return {
      ok: true,
      message: watched ? `Resumed ${target}. First result within a minute.`
        : row.goneAt ? `Resumed ${target}. ${APP_GONE_MESSAGE_SHORT}, so it won't be checked.` : `Resumed ${target}. It's checked again once its app is watched.`,
      audit: { message: `Monitor resumed: ${target}`, resourceId: row.m.resourceId },
    };
  });
}

// Applications / app page → "Pause monitors" / "Resume monitors": every monitor of the app at once.
export async function setAppMonitorsPaused(appId: string, paused: boolean): Promise<Done> {
  const own = await db().select({ paused: monitors.paused, ownerPaused: monitors.ownerPaused, kind: monitors.kind }).from(monitors).where(eq(monitors.resourceId, appId));
  if (!own.length) return { ok: false, error: "This app has no monitors." };
  const now = new Date();
  if (paused) {
    await db().update(monitors).set({ ownerPaused: true, updatedAt: now }).where(eq(monitors.resourceId, appId));
    return {
      ok: true, message: `Paused ${own.length} monitor${own.length === 1 ? "" : "s"}. Their history is kept.`,
      audit: { message: `Monitors paused: ${own.length}`, resourceId: appId },
    };
  }
  const [app] = await db().select({ watched: resources.monitored, goneAt: resources.goneAt }).from(resources).where(eq(resources.id, appId)).limit(1);
  const watched = !!app && app.watched && !app.goneAt;
  const resuming = own.filter((m) => m.ownerPaused).length;
  const plural = resuming === 1 ? "" : "s";
  // Only the HTTP checks count toward the 20-monitor cap; heartbeats are capped by how many exist.
  const resumingChecks = own.filter((m) => m.ownerPaused && !isHeartbeat(m)).length;
  return withMonitorLock(async (c): Promise<Done> => {
    const block = limitBlock(await activeCount(c), watched ? resumingChecks : 0);
    if (block) return { ok: false, error: block };
    await c.update(monitors).set({
      ownerPaused: false, ...(watched ? { paused: false } : {}), state: "unknown", failStreak: 0, stateSince: now, updatedAt: now,
    }).where(and(eq(monitors.resourceId, appId), eq(monitors.ownerPaused, true)));
    return {
      ok: true,
      message: watched
        ? `Resumed ${resuming} monitor${plural}. First results within a minute.`
        : app?.goneAt ? `Resumed ${resuming} monitor${plural}. ${APP_GONE_MESSAGE_SHORT}, so they won't be checked.`
        : `Resumed ${resuming} monitor${plural}. They're checked again once the app is watched.`,
      audit: { message: `Monitors resumed: ${resuming}`, resourceId: appId },
    };
  });
}

// Deletes the console row only (its checks and rollups go with it by cascade). Nothing changes at Vercel. For a watched
// app the statement itself refuses to remove its last monitor (Sync would add it back), under the lock so two deletes
// can't both pass; the number of rows deleted tells which case it was.
// A heartbeat is never the monitor Sync would add back (that is an HTTP check), so it has no such guard.
export async function deleteMonitor(id: string): Promise<Done> {
  const row = await loadMonitor(id);
  if (!row) return GONE;
  const watched = row.watched && !row.goneAt && !isHeartbeat(row.m);
  const hasSibling = sql`(select count(*) from ${monitors} where ${monitors.resourceId} = ${row.m.resourceId}) > 1`;
  const outcome = await withMonitorLock(async (c) => {
    const deleted = await c.delete(monitors).where(and(eq(monitors.id, id), watched ? hasSibling : undefined)).returning({ id: monitors.id });
    if (deleted.length) return "deleted" as const;
    // Task 6 N3: 0 rows is either the sibling guard or a concurrent delete that got there first. Under the same lock,
    // whether the row still exists tells which.
    if (!watched) return "gone" as const;
    return (await c.select({ id: monitors.id }).from(monitors).where(eq(monitors.id, id)).limit(1)).length ? "last" as const : "gone" as const;
  });
  if (outcome === "gone") return GONE;
  if (outcome === "last") return { ok: false, error: deleteBlock({ appWatched: true, monitorsOfApp: 1 }) ?? "That monitor no longer exists." };
  const target = targetOf(row.m);
  return { ok: true, message: `Deleted ${target}.`, audit: { message: `Monitor deleted: ${target}`, resourceId: row.m.resourceId } };
}

function notChecked(row: { m: { paused: boolean; ownerPaused: boolean }; watched: boolean; goneAt: Date | null }): string | null {
  if (row.goneAt) return APP_GONE_MESSAGE;
  if (!row.watched) return "Its app isn't watched. Tick it in Connections → Sync first.";
  return isChecked(row.m) ? null : "Paused monitors aren't checked. Resume it first.";
}

// Checked in the last 50 s: another check would only advance the fail streak (carry-over a), so Check now doesn't
// fetch. It isn't an error either: it answers with the last result, and says whether that result passed (final
// review M1: a failed recent result is not a success toast).
function lastResult(m: typeof monitors.$inferSelect, now: Date): Done | null {
  if (!m.lastCheckedAt || now.getTime() - m.lastCheckedAt.getTime() >= RECHECK_AFTER_MS) return null;
  return { ok: true, message: lastResultMessage({ ...m, lastCheckedAt: m.lastCheckedAt }, now), passed: m.lastStatus === m.expectedStatus && !m.lastError };
}

// Check now. Runs one HTTP check and counts it like a collector check. It doesn't take the collector's lease (task 6
// M2: holding it made the next scheduled run skip every monitor). Instead its write is a compare-and-set on the
// monitor as read here, like the collector's: if a run (or an Edit, a Resume) changed the monitor while this check
// was in flight, this result is dropped and the newer one is shown.
export async function checkMonitorNow(id: string): Promise<Done> {
  const row = await loadMonitor(id);
  if (!row) return GONE;
  if (isHeartbeat(row.m)) return HEARTBEAT_NO_CHECK;
  const unusable = notChecked(row);
  if (unusable) return { ok: false, error: unusable };
  const recent = lastResult(row.m, new Date());
  if (recent) return recent;
  // U5: the maintenance windows are read before anything is written (review M1), so a failed read leaves the monitor
  // as it was instead of a moved fail streak without its checks row.
  const windows = await listRawWindows();
  // Demo: the made-up site isn't fetched; a simulated passing check goes through the same writes as a real one.
  const r = isDemo() ? simulatedCheck(row.m.expectedStatus) : await checkUrl(row.m.url, { expectedStatus: row.m.expectedStatus, timeoutMs: row.m.timeoutMs, body: ruleFrom(row.m) });
  const now = new Date();
  if (!(await writeCheckResult(row.m, r, now))) {
    const fresh = await loadMonitor(id);
    if (!fresh) return GONE;
    return lastResult(fresh.m, new Date()) ?? { ok: false, error: "The monitor changed while it was being checked. Try again." };
  }
  // U5: a Check now inside a maintenance window is stored like the collector's, out of uptime %.
  const inMaintenance = activeFor(windows, { monitorId: id, appId: row.m.resourceId }, now) !== null;
  await db().insert(checks).values({ monitorId: id, at: now, ok: r.ok, statusCode: r.statusCode, latencyMs: r.latencyMs, error: r.error, inMaintenance });
  const next = nextMonitorState(row.m.failStreak, r);
  const ev = monitorEvent({ resourceId: row.m.resourceId, path: pathOf(row.m.url), prev: row.m.state, next: next.state, code: r.statusCode, error: r.error, at: now });
  await recordEvents([ev]);
  return {
    ok: true, message: checkNowMessage(r), passed: r.ok,
    audit: { message: `Check now: ${hostPath(row.m.url)}`, resourceId: row.m.resourceId },
  };
}
