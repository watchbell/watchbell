import { sql } from "drizzle-orm";
import { collectorRuns, monitors } from "@/db/schema";
import { rollup } from "@/lib/collector/rollup";
import { nextMonitorState } from "@/lib/collector/rules";
import { RETENTION_DAYS } from "@/lib/collector/retention";
import type { State } from "@/lib/status";
import type { MonitorFacts, SeededApps } from "./apps";
import { DAY, HOUR, MINUTE, pgArray, type SeedCtx } from "./context";
import { rngFor, stableId } from "./rng";

// HTTP monitors with their history, in the shapes the collector writes: the monitor row with its live state, raw checks
// for the last 7 days (the checks retention) and hourly rollups for 90 days (the rollups retention) up to the last daily
// run. Checks run every 5 minutes (a lighter dataset than the real minutely ones; the monitors say 5 min). Everything is
// one made-up series per monitor, so the raw checks, the rollups and the monitor row always agree with each other.
// One monitor has a short outage (503s, several checks in a row) within the last day, then recovers; another is
// degraded right now (its latest check timed out). Two others were slow for half an hour or so, 2 and 5 days ago (the
// resolved HighLatency alerts are those windows).

export const SLOT_MS = 5 * MINUTE;
const SLOTS_PER_DAY = DAY / SLOT_MS;
const RAW_SLOTS = RETENTION_DAYS.checks * SLOTS_PER_DAY;
const HISTORY_SLOTS = RETENTION_DAYS.rollupsHourly * SLOTS_PER_DAY;
const TIMEOUT_MS = 5000;
const TIMEOUT_ERROR = "No answer within 5 s";
const DAILY_UTC_HOUR = 20; // the daily job runs at 03:00 WIB
const ISOLATED_FAILURE = 0.0003; // about one failed check per monitor per 12 days
const SLOW_SPIKE = 0.02;

export type SeededMonitor = MonitorFacts & { id: string; url: string; path: string; failStreak: number; lastCheckedAt: Date };
export type Outage = { monitorId: string; appId: string; startedAt: Date; endedAt: Date; recoveredAt: Date; failedChecks: number };
// A stretch of slow but passing checks: HighLatency fired on its second check (10 minutes over the limit) and resolved on
// the first normal one after it. p95 is over those first 10 minutes.
export type SlowWindow = { monitorId: string; appId: string; firedAt: Date; resolvedAt: Date; p95: number };
export type SeededUptime = {
  monitors: SeededMonitor[]; outage: Outage; degraded: { monitorId: string; appId: string; since: Date } | null; slow: [SlowWindow, SlowWindow];
};

const SLOW_MIN_MS = 1600; // above HighLatency's 1,500 ms default

// Newest first: index k is the check k slots before the latest one. status 0 and latency -1 stand for null.
type Series = { ok: Uint8Array; status: Int16Array; latency: Int32Array };

type Plan = { id: string; appId: string; index: number; url: string; path: string; createdAt: Date };

export async function seedUptime(ctx: SeedCtx, seeded: SeededApps): Promise<SeededUptime> {
  const { db, seed, now } = ctx;
  const rng = rngFor(seed, "monitors");
  const plans: Plan[] = [];
  for (const app of seeded.apps) {
    const paths = rng.chance(0.6) ? ["/", "/api/health"] : ["/"];
    for (const [i, path] of paths.entries()) {
      plans.push({
        id: stableId(seed, "monitor", app.name, path), appId: app.id, index: plans.length, url: `https://${app.host}${path}`, path,
        createdAt: new Date(app.createdAt.getTime() + (i * rng.int(1, 3) * DAY) + rng.int(2, 50) * MINUTE),
      });
    }
  }

  // Slot times: the latest run started on a 5-minute boundary at least 10 s ago; each monitor's check a few seconds in.
  const base = Math.floor((now.getTime() - 10_000) / SLOT_MS) * SLOT_MS;
  const atOf = (p: Plan, k: number) => base - k * SLOT_MS + 2000 + p.index * 300;

  const series = plans.map((p) => madeUpSeries(seed, p));

  const outageRng = rngFor(seed, "outage");
  const roots = plans.filter((p) => p.path === "/");
  const hit = outageRng.pick(roots);
  const newest = outageRng.int(8 * 12, 20 * 12); // 8-20 h ago
  const length = outageRng.int(4, 7); // 20-35 min
  const s = series[hit.index];
  for (let k = newest - 3; k < newest + length + 3; k++) setCheck(s, k, { ok: true, status: 200, latency: s.latency[k] > 0 ? s.latency[k] : 180 });
  for (let k = newest; k < newest + length; k++) {
    setCheck(s, k, { ok: false, status: k === newest + length - 1 ? 502 : 503, latency: outageRng.int(30, 140) });
  }
  const outage: Outage = {
    monitorId: hit.id, appId: hit.appId, startedAt: new Date(atOf(hit, newest + length - 1)), endedAt: new Date(atOf(hit, newest)),
    recoveredAt: new Date(atOf(hit, newest - 1)), failedChecks: length,
  };

  const others = plans.filter((p) => p.appId !== hit.appId);
  const slow = others.length ? outageRng.pick(others) : null;
  if (slow) setCheck(series[slow.index], 0, { ok: false, status: 0, latency: -1 });

  // The slow windows: 2 and 5 days ago (plus 1-12 h), each on a monitor other than the outage's.
  const slowRng = rngFor(seed, "slow-windows");
  const notHit = plans.filter((p) => p.id !== hit.id);
  const slowWindow = (p: Plan, daysAgo: number, minSlots: number, maxSlots: number): SlowWindow => {
    const s = series[p.index];
    const oldest = daysAgo * SLOTS_PER_DAY + slowRng.int(12, 144);
    const length = slowRng.int(minSlots, maxSlots);
    const rows: { ok: boolean; statusCode: number; latencyMs: number }[] = [];
    for (let k = oldest; k > oldest - length; k--) {
      const latency = slowRng.int(SLOW_MIN_MS, 2900);
      setCheck(s, k, { ok: true, status: 200, latency });
      if (rows.length < 2) rows.push({ ok: true, statusCode: 200, latencyMs: latency });
    }
    const after = oldest - length; // the check it resolved on: a normal, passing one under the HighLatency threshold
    if (!s.ok[after] || s.latency[after] >= 1500) setCheck(s, after, { ok: true, status: 200, latency: 180 });
    return { monitorId: p.id, appId: p.appId, firedAt: new Date(atOf(p, oldest - 1)), resolvedAt: new Date(atOf(p, after)), p95: rollup(rows).p95Ms! };
  };
  const slowA = notHit[0] ?? hit;
  const slowB = notHit[notHit.length - 1] ?? hit;
  const slowWindows: [SlowWindow, SlowWindow] = [slowWindow(slowA, 2, 4, 8), slowWindow(slowB, 5, 3, 6)];

  const seededMonitors = plans.map((p) => liveState(p, series[p.index], (k) => new Date(atOf(p, k))));
  await db.insert(monitors).values(seededMonitors.map((m, i) => ({
    id: m.id, resourceId: m.appId, url: m.url, kind: "http" as const, expectedStatus: 200, timeoutMs: TIMEOUT_MS, intervalS: SLOT_MS / 1000,
    state: m.state, stateSince: m.stateSince, failStreak: m.failStreak, lastCheckedAt: m.lastCheckedAt, lastStatus: m.lastStatus,
    lastLatencyMs: m.lastLatencyMs, lastError: errorOf(series[i], 0), createdAt: m.createdAt, updatedAt: m.lastCheckedAt,
  })));

  const lastDaily = lastDailyRun(now);
  for (const p of plans) {
    await insertChecks(ctx, p, series[p.index], new Date(atOf(p, 0)));
    await insertRollups(ctx, p, series[p.index], (k) => atOf(p, k), lastDaily);
  }
  await insertRuns(ctx, plans.length);

  return { monitors: seededMonitors, outage, degraded: slow ? { monitorId: slow.id, appId: slow.appId, since: new Date(atOf(slow, 0)) } : null, slow: slowWindows };
}

function madeUpSeries(seed: string, p: Plan): Series {
  const rng = rngFor(seed, "checks", p.id);
  const s: Series = { ok: new Uint8Array(HISTORY_SLOTS), status: new Int16Array(HISTORY_SLOTS), latency: new Int32Array(HISTORY_SLOTS) };
  const typical = rng.int(70, 380) * (p.path === "/" ? 1 : 0.55);
  for (let k = 0; k < HISTORY_SLOTS; k++) {
    const jitter = 0.75 + 0.5 * rng.next();
    const spike = rng.chance(SLOW_SPIKE) ? 1.8 + 2 * rng.next() : 1;
    const latency = Math.round(typical * jitter * spike);
    // The latest three checks pass, so only the chosen monitor is degraded now.
    if (k >= 3 && rng.chance(ISOLATED_FAILURE)) {
      const kind = rng.int(0, 3);
      setCheck(s, k, kind === 3 ? { ok: false, status: 0, latency: -1 } : { ok: false, status: [500, 502, 503][kind], latency: rng.int(30, 300) });
    } else {
      setCheck(s, k, { ok: true, status: 200, latency });
    }
  }
  return s;
}

function setCheck(s: Series, k: number, c: { ok: boolean; status: number; latency: number }): void {
  if (k < 0 || k >= s.ok.length) return;
  s.ok[k] = c.ok ? 1 : 0;
  s.status[k] = c.status;
  s.latency[k] = c.latency;
}

const statusOf = (s: Series, k: number) => (s.status[k] === 0 ? null : s.status[k]);
const latencyOf = (s: Series, k: number) => (s.latency[k] < 0 ? null : s.latency[k]);
// As the HTTP check words it: a wrong status is "HTTP 503", no answer at all is the timeout.
const errorOf = (s: Series, k: number) => (s.ok[k] ? null : s.status[k] ? `HTTP ${s.status[k]}` : TIMEOUT_ERROR);

// The monitor row after the whole series, by the collector's own rule (down after 3 failures in a row).
function liveState(p: Plan, s: Series, at: (k: number) => Date): SeededMonitor {
  let state: State = "unknown";
  let failStreak = 0;
  let since = p.createdAt;
  for (let k = s.ok.length - 1; k >= 0; k--) {
    const next = nextMonitorState(failStreak, { ok: s.ok[k] === 1, statusCode: statusOf(s, k), latencyMs: latencyOf(s, k), error: errorOf(s, k) });
    if (next.state !== state) since = at(k);
    state = next.state;
    failStreak = next.failStreak;
  }
  return {
    id: p.id, appId: p.appId, url: p.url, path: p.path, state, stateSince: since, failStreak, lastCheckedAt: at(0),
    lastStatus: statusOf(s, 0), lastLatencyMs: latencyOf(s, 0), createdAt: p.createdAt,
  };
}

// The newest 03:00 WIB (20:00 UTC) at least a few minutes before now: the daily job's rollups cover every hour before it.
function lastDailyRun(now: Date): number {
  const d = new Date(now);
  d.setUTCHours(DAILY_UTC_HOUR, 0, 0, 0);
  if (d.getTime() > now.getTime() - 5 * MINUTE) d.setTime(d.getTime() - DAY);
  return d.getTime();
}

// The raw checks of the last 7 days in one statement. Ids are md5(seed, monitor, slot), so a re-seed writes the same ids.
async function insertChecks(ctx: SeedCtx, p: Plan, s: Series, latest: Date): Promise<void> {
  const ks = Array.from({ length: RAW_SLOTS }, (_, k) => k);
  await ctx.db.execute(sql`
    insert into ops.checks (id, monitor_id, at, ok, status_code, latency_ms, error, in_maintenance)
    select md5(${`${ctx.seed}:${p.id}:`} || t.k)::uuid, ${p.id}::uuid, ${latest.toISOString()}::timestamptz - t.k * interval '5 minutes',
      t.ok, t.s, t.l, case when t.ok then null when t.s is null then ${TIMEOUT_ERROR} else 'HTTP ' || t.s end, false
    from unnest(${pgArray(ks)}::int[], ${pgArray(ks.map((k) => s.ok[k] === 1))}::bool[], ${pgArray(ks.map((k) => statusOf(s, k)))}::int[],
      ${pgArray(ks.map((k) => latencyOf(s, k)))}::int[]) as t(k, ok, s, l)`);
}

// Whole UTC hours before the last daily run, back to the 90-day retention, through the collector's own rollup().
async function insertRollups(ctx: SeedCtx, p: Plan, s: Series, atMs: (k: number) => number, lastDaily: number): Promise<void> {
  const firstFull = Math.ceil(atMs(s.ok.length - 1) / HOUR) * HOUR;
  const out = { hour: [] as number[], checks: [] as number[], failures: [] as number[], p50: [] as (number | null)[], p95: [] as (number | null)[], max: [] as (number | null)[], s5xx: [] as number[] };
  let hour = -1;
  let rows: { ok: boolean; statusCode: number | null; latencyMs: number | null }[] = [];
  const flush = () => {
    if (hour < 0 || !rows.length) return;
    const r = rollup(rows);
    out.hour.push(hour / 1000);
    out.checks.push(r.checks);
    out.failures.push(r.failures);
    out.p50.push(r.p50Ms);
    out.p95.push(r.p95Ms);
    out.max.push(r.maxMs);
    out.s5xx.push(r.status5xx);
  };
  for (let k = 0; k < s.ok.length; k++) {
    const at = atMs(k);
    const h = Math.floor(at / HOUR) * HOUR;
    if (h >= lastDaily) continue;
    if (h < firstFull) break;
    if (h !== hour) {
      flush();
      hour = h;
      rows = [];
    }
    rows.push({ ok: s.ok[k] === 1, statusCode: statusOf(s, k), latencyMs: latencyOf(s, k) });
  }
  flush();
  if (!out.hour.length) return;
  await ctx.db.execute(sql`
    insert into ops.rollups_hourly (monitor_id, hour, checks, failures, p50_ms, p95_ms, max_ms, status_5xx, maintenance)
    select ${p.id}::uuid, to_timestamp(t.h), t.c, t.f, t.p50, t.p95, t.mx, t.s5, 0
    from unnest(${pgArray(out.hour)}::bigint[], ${pgArray(out.checks)}::int[], ${pgArray(out.failures)}::int[], ${pgArray(out.p50)}::int[],
      ${pgArray(out.p95)}::int[], ${pgArray(out.max)}::int[], ${pgArray(out.s5xx)}::int[]) as t(h, c, f, p50, p95, mx, s5)`);
}

// The minute collector's runs of the last hour; the ones on a 5-minute boundary are the ones that checked the monitors.
async function insertRuns(ctx: SeedCtx, monitorCount: number): Promise<void> {
  const { seed, now } = ctx;
  const rng = rngFor(seed, "collector-runs");
  const minute = Math.floor((now.getTime() - 10_000) / MINUTE) * MINUTE;
  await ctx.db.insert(collectorRuns).values(Array.from({ length: 60 }, (_, j) => {
    const start = minute - j * MINUTE;
    const checked = start % SLOT_MS === 0;
    const duration = (checked ? 2000 + monitorCount * 300 : 600) + rng.int(200, 1400);
    return {
      id: stableId(seed, "collector-run", j), startedAt: new Date(start + 1000), finishedAt: new Date(start + 1000 + duration), trigger: "manual" as const,
      tasks: checked ? ["heartbeats", "checks", "vercel", "alerts"] : ["heartbeats", "vercel", "alerts"], ok: true, durationMs: duration,
      checks: checked ? monitorCount : 0,
    };
  }));
}

