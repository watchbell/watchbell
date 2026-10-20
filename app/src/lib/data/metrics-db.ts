import "server-only";
import { and, eq, gte, inArray, isNull, lt, max, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db/client";
import { checks, deployments, monitors, resources, rollupsHourly } from "@/db/schema";
import type { DeployMark } from "@/lib/view/deploy-marks";
import { dayStart, timeZone, utcOffsetMinutes } from "@/lib/time";
import { BAR_DAYS, type DayCount, dayKeys, firstBucket, mergeDays, type MonitorDay, series } from "@/lib/view/uptime";
import { WINDOWS } from "@/lib/view/windows";

const HOUR = 3_600_000;

// R3: days are local calendar days in the configured zone (lib/time.ts), passed as a bound parameter. A rollup hour is a
// whole UTC hour and counts on the local day it starts in: exact in whole-hour zones (WIB), off by the extra 30 or 45
// minutes at midnight in a zone such as Asia/Kolkata. Each use of the expression binds its own parameter, and Postgres
// can't tell two parameters are equal, so a query groups by this column's position (DAY_COLUMN), not by the expression.
// A zone Postgres doesn't know (its tz data can be older than Node's) is read instead as a fixed offset from UTC: see
// monitorDays.
type DayZone = string | { offsetMinutes: number };
const localDaySql = (col: AnyPgColumn, zone: DayZone) =>
  typeof zone === "string"
    ? sql<string>`to_char(${col} at time zone ${zone}, 'YYYY-MM-DD')`
    : sql<string>`to_char((${col} at time zone 'UTC') + ${sql.raw(`interval '${Math.trunc(zone.offsetMinutes)} minutes'`)}, 'YYYY-MM-DD')`;
// `day` is the second field of both selects in monitorDays.
const DAY_COLUMN = sql.raw("2");

// Postgres's "time zone "…" not recognized" (SQLSTATE 22023), also when drizzle wraps it (DrizzleQueryError.cause).
export function unknownZoneError(e: unknown): boolean {
  let x: unknown = e;
  for (let i = 0; i < 4 && x && typeof x === "object"; i++, x = (x as { cause?: unknown }).cause) {
    const { code, message } = x as { code?: unknown; message?: unknown };
    if (code === "22023" && typeof message === "string" && /time zone .* not recognized/i.test(message)) return true;
  }
  return false;
}
type Warned = { __watchbellPgZoneWarned?: boolean };

// Bucket start in epoch ms, binned from the same origin as BIN_ORIGIN in view/uptime. The size is a fixed literal,
// not a parameter, so the expression in SELECT and GROUP BY is identical.
const bin = (size: "30 minutes" | "48 minutes" | "1 hour", col: AnyPgColumn): SQL<number> =>
  sql<number>`(extract(epoch from date_bin(${sql.raw(`'${size}'`)}::interval, ${col}, timestamptz '2000-01-01 00:00:00+00')) * 1000)::float8`;

// p95 here is percentile_cont (interpolated); collector/rollup.ts uses nearest-rank, so do not mix the two in one series.
const p95 = sql<number | null>`percentile_cont(0.95) within group (order by ${checks.latencyMs})`;
// A6: p50 next to p95, the same interpolated kind.
const p50 = sql<number | null>`percentile_cont(0.5) within group (order by ${checks.latencyMs})`;
const failed = sql<number>`(count(*) filter (where not ${checks.ok}))::int`;
// U5 / B3: checks made inside a maintenance window are stored, but left out of uptime %, failures and latency.
const counted = eq(checks.inMaintenance, false);
const s5xx = sql<number>`(count(*) filter (where ${checks.statusCode} >= 500))::int`;
const total = sql<number>`count(*)::int`;

// Lower bound for the raw-checks read in monitorDays: never before the window or the 7-day retention, and never before
// rolledUntil, so an hour is counted from rollups or from raw checks, never both.
export const rawChecksFrom = (since: Date, until: Date | null, now: Date): Date =>
  new Date(Math.max(since.getTime(), until?.getTime() ?? 0, now.getTime() - WINDOWS.rawChecksMs));

// The first hour the daily job hasn't rolled up yet (null before the first rollup). Rollups cover every hour before it.
// Global max(hour): a daily run killed half-way, or not run for over 7 days, under-counts (never double-counts) until the next run.
export async function rolledUntil(): Promise<Date | null> {
  const [r] = await db().select({ h: max(rollupsHourly.hour) }).from(rollupsHourly);
  return r?.h ? new Date(r.h.getTime() + HOUR) : null;
}

// Checks and failures per monitor per local day for the last 90 days (R3): rollups for the rolled-up hours, raw checks
// (at most 7 days) for the rest. At most monitors × 90 rows come back. U5: `checks` and `failures` leave out the
// checks made inside a maintenance window, which are counted apart as `maint` (a day of only those is drawn blue).
// A zone Postgres refuses never takes the Uptime, app or public status pages down: the days are then counted at the
// zone's offset at `now` (exact but for an hour around a daylight-saving change), with one warning per process.
// `zone` is for tests (a name Postgres doesn't know); callers leave it out.
export async function monitorDays(monitorIds: string[], now: Date, zone: string = timeZone()): Promise<Map<string, Map<string, DayCount>>> {
  if (!monitorIds.length) return new Map();
  try {
    return await readMonitorDays(monitorIds, now, zone);
  } catch (e) {
    if (!unknownZoneError(e)) throw e;
    const g = globalThis as Warned;
    if (!g.__watchbellPgZoneWarned) {
      g.__watchbellPgZoneWarned = true;
      console.warn(`Watchbell: the database doesn't know the time zone ${zone}; uptime days use its current UTC offset instead.`);
    }
    return readMonitorDays(monitorIds, now, { offsetMinutes: utcOffsetMinutes(now) });
  }
}

async function readMonitorDays(monitorIds: string[], now: Date, zone: DayZone): Promise<Map<string, Map<string, DayCount>>> {
  const since = dayStart(dayKeys(now, BAR_DAYS)[0]);
  const until = await rolledUntil();
  const rawFrom = rawChecksFrom(since, until, now);
  const rDay = localDaySql(rollupsHourly.hour, zone);
  const cDay = localDaySql(checks.at, zone);
  // The rollup and raw-check reads are independent once `until` is known: sent together (perf P4).
  const [rolled, raw]: MonitorDay[][] = await Promise.all([
    until
      ? db().select({
        monitorId: rollupsHourly.monitorId, day: rDay,
        checks: sql<number>`sum(${rollupsHourly.checks})::int`, failures: sql<number>`sum(${rollupsHourly.failures})::int`,
        maint: sql<number>`sum(${rollupsHourly.maintenance})::int`,
      }).from(rollupsHourly)
        .where(and(inArray(rollupsHourly.monitorId, monitorIds), gte(rollupsHourly.hour, since), lt(rollupsHourly.hour, until)))
        .groupBy(rollupsHourly.monitorId, DAY_COLUMN)
      : Promise.resolve([]),
    db().select({
      monitorId: checks.monitorId, day: cDay,
      checks: sql<number>`(count(*) filter (where not ${checks.inMaintenance}))::int`,
      failures: sql<number>`(count(*) filter (where not ${checks.ok} and not ${checks.inMaintenance}))::int`,
      maint: sql<number>`(count(*) filter (where ${checks.inMaintenance}))::int`,
    })
      .from(checks)
      .where(and(inArray(checks.monitorId, monitorIds), gte(checks.at, rawFrom)))
      .groupBy(checks.monitorId, DAY_COLUMN),
  ]);
  return mergeDays([...rolled, ...raw]);
}

export type AppResponse = { hourly: (number | null)[]; p95: number | null; p50: number | null };

// Applications → Response 24h (R3): hourly p95 per app from raw checks, plus the p95 and p50 over the whole 24 h.
export async function appResponse(appIds: string[], now: Date): Promise<Map<string, AppResponse>> {
  if (!appIds.length) return new Map();
  const n = WINDOWS.responseHours;
  const first = firstBucket(now, HOUR, n);
  const t = bin("1 hour", checks.at);
  const scope = and(inArray(monitors.resourceId, appIds), gte(checks.at, new Date(first)), counted);
  const [hourly, overall] = await Promise.all([ // independent: sent together (perf P4)
    db().select({ appId: monitors.resourceId, t, v: p95 }).from(checks)
      .innerJoin(monitors, eq(monitors.id, checks.monitorId)).where(scope).groupBy(monitors.resourceId, t),
    db().select({ appId: monitors.resourceId, v: p95, m: p50 }).from(checks)
      .innerJoin(monitors, eq(monitors.id, checks.monitorId)).where(scope).groupBy(monitors.resourceId),
  ]);
  return new Map(appIds.map((id) => [id, {
    hourly: series(hourly.filter((r) => r.appId === id), first, HOUR, n),
    p95: overall.find((r) => r.appId === id)?.v ?? null,
    p50: overall.find((r) => r.appId === id)?.m ?? null,
  }]));
}

// App → Metrics: 48 half-hour points of p95 and p50 response and 5xx count over 24 h, from raw checks. `first` and
// `sizeMs` place the deploy ticks on the same axis.
export async function appMetrics(appId: string, now: Date): Promise<{
  response: (number | null)[]; median: (number | null)[]; errors: (number | null)[]; first: number; sizeMs: number;
}> {
  const size = 30 * 60_000;
  const n = WINDOWS.metricBuckets;
  const first = firstBucket(now, size, n);
  const t = bin("30 minutes", checks.at);
  const rows = await db().select({ t, p95, p50, s5xx }).from(checks)
    .innerJoin(monitors, eq(monitors.id, checks.monitorId))
    .where(and(eq(monitors.resourceId, appId), gte(checks.at, new Date(first)), counted))
    .groupBy(t);
  return {
    response: series(rows.map((r) => ({ t: r.t, v: r.p95 })), first, size, n),
    median: series(rows.map((r) => ({ t: r.t, v: r.p50 })), first, size, n),
    errors: series(rows.map((r) => ({ t: r.t, v: r.s5xx })), first, size, n, 0),
    first, sizeMs: size,
  };
}

// A1: production deploys of one app since a time (ticks on the 24 h chart, marks on the 90-day bars). Bounded (R8).
export async function productionDeploys(appId: string, since: Date): Promise<DeployMark[]> {
  return db().select({ at: deployments.createdAtProvider, sha: deployments.commitSha, state: deployments.state }).from(deployments)
    .where(and(eq(deployments.resourceId, appId), eq(deployments.target, "production"), gte(deployments.createdAtProvider, since)))
    .orderBy(deployments.createdAtProvider).limit(200);
}

export type Health = {
  uptime: number | null; p95: number | null; s5xx: number; deploys: number;
  series: { uptime: (number | null)[]; p95: (number | null)[]; s5xx: (number | null)[]; deploys: (number | null)[] };
};

// Overview → Health: the last 24 h of every watched app, as totals and 30 points of 48 minutes each.
export async function health(now: Date): Promise<Health> {
  const size = 48 * 60_000;
  const n = WINDOWS.healthBuckets;
  const first = firstBucket(now, size, n);
  const since = new Date(first);
  const watched = and(eq(resources.monitored, true), isNull(resources.goneAt));
  const t = bin("48 minutes", checks.at);
  const dt = bin("48 minutes", deployments.createdAtProvider);
  // Three independent reads, sent together (perf P4).
  const [bins, [sum], deps] = await Promise.all([
    db().select({ t, checks: total, failures: failed, s5xx, p95 }).from(checks)
      .innerJoin(monitors, eq(monitors.id, checks.monitorId)).innerJoin(resources, eq(resources.id, monitors.resourceId))
      .where(and(watched, gte(checks.at, since), counted)).groupBy(t),
    db().select({ checks: total, failures: failed, s5xx, p95 }).from(checks)
      .innerJoin(monitors, eq(monitors.id, checks.monitorId)).innerJoin(resources, eq(resources.id, monitors.resourceId))
      .where(and(watched, gte(checks.at, since), counted)),
    db().select({ t: dt, n: total }).from(deployments)
      .innerJoin(resources, eq(resources.id, deployments.resourceId))
      .where(and(watched, gte(deployments.createdAtProvider, since))).groupBy(dt),
  ]);
  const up = (c: number, f: number) => (c ? ((c - f) / c) * 100 : null);
  return {
    uptime: sum ? up(sum.checks, sum.failures) : null,
    p95: sum?.p95 ?? null,
    s5xx: sum?.s5xx ?? 0,
    deploys: deps.reduce((s, r) => s + r.n, 0),
    series: {
      uptime: series(bins.map((b) => ({ t: b.t, v: up(b.checks, b.failures) })), first, size, n),
      p95: series(bins.map((b) => ({ t: b.t, v: b.p95 })), first, size, n),
      s5xx: series(bins.map((b) => ({ t: b.t, v: b.s5xx })), first, size, n, 0),
      deploys: series(deps.map((d) => ({ t: d.t, v: d.n })), first, size, n, 0),
    },
  };
}
