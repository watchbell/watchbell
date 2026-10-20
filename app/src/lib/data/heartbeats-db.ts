import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { checks, monitors, resources } from "@/db/schema";
import { monitorEvent, type NewEvent } from "@/lib/collector/rules";
import { recheckable } from "@/lib/collector/schedule";
import { recordEvents } from "@/lib/data/events-write";
import { heartbeatState } from "@/lib/heartbeat";
import { tokenHash } from "@/lib/heartbeat-token";
import { LIMITS } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

// Used when a heartbeat row predates its period/grace (the check constraint makes that impossible; this only keeps
// the types honest).
const DEFAULT_PERIOD_S = 3600;
const DEFAULT_GRACE_S = 600;

// One indexed lookup by hash; unknown tokens cost no write (B2). The token itself is never stored, logged or used as
// a rate-limit subject: only its sha256 is. The state is recomputed by the collector within a minute
// (taskHeartbeats), so a ping never races a check.
// A limited ping says how long until its window ends (the route's Retry-After).
export type PingOutcome = { status: "ok" } | { status: "unknown" } | { status: "limited"; retryAfter: number };

export async function recordPing(token: string, kind: "ok" | "fail" | "start", now: Date): Promise<PingOutcome> {
  const hash = tokenHash(token);
  const [m] = await db().select({ id: monitors.id }).from(monitors).where(and(eq(monitors.tokenHash, hash), eq(monitors.kind, "heartbeat"))).limit(1);
  if (!m) return { status: "unknown" };
  const q = await limit(LIMITS.ping, hash);
  if (!q.allowed) return { status: "limited", retryAfter: q.retryAfter };
  await db().update(monitors).set({ lastPingAt: now, lastPingKind: kind, updatedAt: now }).where(eq(monitors.id, m.id));
  return { status: "ok" };
}

// The `heartbeats` task (every run): recompute each heartbeat's state, store one check per run (ok unless down) so the
// 90-day bars and uptime % work like HTTP monitors, and write the usual monitor events on a change.
// Each write is a compare-and-set on what this run read (the last ping, the period and grace, the state, the pause): a
// ping, an Edit or a Pause that lands in between wins, and this run writes no check and no event for that heartbeat
// (the next run recomputes it a minute later).
// A forced run (Refresh now, the watchdog) skips a heartbeat recomputed in the last 50 s, as taskChecks does for HTTP
// monitors, so repeated refreshes don't add checks rows that outweigh the rest of the minute in uptime % (5b final
// review M3).
// `onlyId` (a test ping from the console): recompute that one heartbeat at once, so its new state shows without waiting
// for the next run. It still writes a checks row only when the last one is 50 s or older (M3), so clicking test pings
// can't outweigh the rest of the minute in uptime %.
export async function taskHeartbeats(
  now: Date, inMaintenance: (monitorId: string, appId: string) => boolean = () => false, force = false, onlyId?: string,
): Promise<number> {
  const list = (await db().select({ m: monitors }).from(monitors).innerJoin(resources, eq(resources.id, monitors.resourceId))
    .where(and(eq(monitors.kind, "heartbeat"), eq(monitors.paused, false), eq(monitors.ownerPaused, false), eq(resources.monitored, true), isNull(resources.goneAt),
      ...(onlyId ? [eq(monitors.id, onlyId)] : []))))
    .filter(({ m }) => onlyId !== undefined || recheckable(m.lastCheckedAt, now, force));
  const evs: (NewEvent | null)[] = [];
  const rows: (typeof checks.$inferInsert)[] = [];
  for (const { m } of list) {
    const periodS = m.periodS ?? DEFAULT_PERIOD_S;
    const graceS = m.graceS ?? DEFAULT_GRACE_S;
    const s = heartbeatState({ lastPingAt: m.lastPingAt, lastPingKind: m.lastPingKind, periodS, graceS, createdAt: m.createdAt }, now);
    if (s.state === "unknown") continue;
    const changed = s.state !== m.state;
    const written = await db().update(monitors).set({
      state: s.state, failStreak: s.failStreak, lastCheckedAt: now, lastError: s.state === "ok" ? null : s.text,
      ...(changed ? { stateSince: now } : {}), updatedAt: now,
    }).where(and(
      eq(monitors.id, m.id), eq(monitors.state, m.state), eq(monitors.ownerPaused, false), eq(monitors.paused, false),
      m.lastPingAt === null ? isNull(monitors.lastPingAt) : eq(monitors.lastPingAt, m.lastPingAt),
      m.periodS === null ? isNull(monitors.periodS) : eq(monitors.periodS, m.periodS),
      m.graceS === null ? isNull(monitors.graceS) : eq(monitors.graceS, m.graceS),
    )).returning({ id: monitors.id });
    if (!written.length) continue;
    if (onlyId === undefined || recheckable(m.lastCheckedAt, now, true)) rows.push({ monitorId: m.id, at: now, ok: s.state !== "err", statusCode: null, latencyMs: null, error: s.state === "ok" ? null : s.text, inMaintenance: inMaintenance(m.id, m.resourceId) });
    evs.push(monitorEvent({ resourceId: m.resourceId, path: m.name ?? "heartbeat", prev: m.state, next: s.state, code: null, error: s.text, at: now, heartbeat: true }));
  }
  if (rows.length) await db().insert(checks).values(rows);
  await recordEvents(evs);
  return rows.length;
}
