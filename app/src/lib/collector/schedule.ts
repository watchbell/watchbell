// Seconds between runs of each task, in run order. Every minute: checks, Vercel and the alert rules. The database reads
// are spread out to fit the free tiers (spec §15): Supabase and Neon status and the Firestore health read every 5 min,
// Supabase health/traffic and Firestore usage hourly; database size and Auth user counts are daily (/api/daily, step
// "databases"). The network tasks (stage 4) are hourly, 6-hourly or daily: tls and rdap run hourly but only touch items
// not read for 20 h, so each item is read about daily and a run that runs out of time leaves the rest for the next hour.
// Stage 5: provider status feeds, the copy of Vercel warning/error logs and the digest's due check every 5 minutes.
// Stage 5b: `heartbeats` (U3) recomputes every heartbeat from its last ping, every minute. It reads and writes only the
// console's own database (one select, at most 20 small updates and one insert), so it runs FIRST: the HTTP checks are
// cut to the run's deadline, and in a broad outage they use all of it, which is exactly when the owner's jobs stop
// pinging too (5b final review I1). It still comes well before `alerts`, which reads the states it writes.
// Page views (Vercel Web Analytics, two small reads per app) every 30 minutes.
// `alerts` and `digest` stay LAST: they read what the tasks before them refreshed (runCollector runs them after the
// state refresh, in time it keeps back for them; see ALERTS_RESERVE_MS).
export const TASKS = {
  heartbeats: 60,
  checks: 60,
  vercel: 60,
  supabase: 300,
  supabaseUsage: 3600,
  neon: 300,
  firebase: 300,
  firebaseUsage: 3600,
  extraDbs: 3600, // stage 8: Turso, Upstash Redis and Cloudflare D1 status and usage
  cloudflare: 3600,
  domains: 21_600,
  tls: 3600,
  rdap: 3600,
  eol: 86_400,
  status: 300,
  logs: 300,
  pageviews: 1800,
  alerts: 60,
  digest: 300,
} as const;
export type TaskName = keyof typeof TASKS;
export const BUDGET_MS = 20_000;
export const LEASE_MS = 55_000;
// A forced run (Refresh now, the watchdog) re-runs only the minute tasks; slower provider reads keep their interval.
export const FORCE_MAX_S = 60;
const SLACK_MS = 5_000;
// The per-minute tasks get more: cron-job.org fires every 60 s but a run can start up to ~15 s late, so the next one may
// come 50-55 s after it (13 Oct 2026: 03:45:13 then 03:46:07 skipped checks, vercel and alerts for that minute).
const MINUTE_SLACK_MS = 10_000;
const MIN = 60;

// Where in its interval each slower task runs, in seconds after the UTC epoch-aligned start of the interval. Tasks
// with the same interval sit in different minutes, and no two hourly tasks share a minute, so they never all fall
// due in one run (integration risk after stages 3 and 4). The 5-minute tasks take one minute each of the five
// (digest, a settings read, shares Supabase's); the hourly and longer ones avoid the logs minute (:x4/:x9) and never share
// a minute with each other, so steady state has at most two slower tasks in any run.
//   5-minute: supabase and digest :x0/:x5, neon :x1/:x6, firebase :x2/:x7, status :x3/:x8, logs :x4/:x9
//   hourly:   supabaseUsage :11, extraDbs :16, firebaseUsage :22, cloudflare :33, tls :41, rdap :52
//   30-minute: pageviews :27/:57 (no hourly task there; only firebase's 5-minute slot shares the minute)
//   domains:  01:28, 07:28, 13:28, 19:28 UTC · eol: 03:46 UTC (10:46 WIB)
export const OFFSETS: Partial<Record<TaskName, number>> = {
  supabase: 0, digest: 0, neon: 1 * MIN, firebase: 2 * MIN, status: 3 * MIN, logs: 4 * MIN, pageviews: 27 * MIN,
  supabaseUsage: 11 * MIN, extraDbs: 16 * MIN, firebaseUsage: 22 * MIN, cloudflare: 33 * MIN, tls: 41 * MIN, rdap: 52 * MIN,
  domains: 88 * MIN, eol: 226 * MIN,
};

// At most this many slower tasks that are late (never ran, or missed their slot: first deploy, a collector outage)
// start in one run, in TASKS order. After a deploy the ten new tasks then spread over about five minutes instead of
// all landing in the first run's 20 s.
export const CATCH_UP_PER_RUN = 2;

// The start of the slot `now` falls in (ms). The few seconds of slack let a run that starts just before the minute
// turns (cron-job.org's jitter) count for that minute's slot.
export function slotStart(task: TaskName, now: Date): number {
  const interval = TASKS[task] * 1000;
  const offset = (OFFSETS[task] ?? 0) * 1000;
  const t = now.getTime() + SLACK_MS - offset;
  return Math.floor(t / interval) * interval + offset;
}

// Which tasks this run should do. Minute tasks: every run (a forced run too, unless one ran under 55 s ago, which only a
// forced run can see). Slower tasks: once per slot, never on a forced run's account, so pressing Refresh can't spend
// Cloudflare, RDAP or TLS requests (free-tier budget, spec §15). A slower task whose slot began more than a minute ago
// (late) counts toward CATCH_UP_PER_RUN.
export function dueTasks(lastRun: Partial<Record<TaskName, string>>, now: Date, force: boolean): TaskName[] {
  let catchUps = 0;
  return (Object.keys(TASKS) as TaskName[]).filter((t) => {
    const last = lastRun[t] ? new Date(lastRun[t]!).getTime() : null;
    if (TASKS[t] <= FORCE_MAX_S) {
      if (last === null || force) return true;
      return now.getTime() - last >= TASKS[t] * 1000 - MINUTE_SLACK_MS;
    }
    const start = slotStart(t, now);
    if (last !== null && last >= start - SLACK_MS) return false; // already ran in this slot
    const late = last === null || now.getTime() + SLACK_MS - start >= MIN * 1000;
    if (!late) return true;
    if (catchUps >= CATCH_UP_PER_RUN) return false;
    catchUps++;
    return true;
  });
}

const MIN_CHECK_MS = 1000;

// A check may not outlive the run: its timeout is cut to what is left before the deadline, and with under a second
// left it isn't started at all (null).
export function checkTimeout(monitorTimeoutMs: number, deadline: number, now: number): number | null {
  const timeout = Math.min(monitorTimeoutMs, deadline - now);
  return timeout < MIN_CHECK_MS ? null : timeout;
}

// A forced run (Refresh now, the watchdog) doesn't re-check a monitor checked in the last 50 s: each extra failed
// check advances its fail streak, so a double-clicked refresh could otherwise mark a site down after two real minutes.
export const RECHECK_AFTER_MS = 50_000;

export function recheckable(lastCheckedAt: Date | null, now: Date, force: boolean): boolean {
  if (!force || !lastCheckedAt) return true;
  return now.getTime() - lastCheckedAt.getTime() >= RECHECK_AFTER_MS;
}

// A task that needs this much of the run left is deferred to the next run instead (not an error, not marked as run).
// eol makes one read of up to 8 s (cut to what is left), so it needs the same margin as a TLS or RDAP read.
export const MIN_LEFT_MS: Partial<Record<TaskName, number>> = { status: 6_000, logs: 9_000, pageviews: 9_000, digest: 6_000, eol: 6_000 };

// The time the run keeps back for `alerts` (evaluate every rule, then deliver queued notices): the tasks before it get
// a deadline this much earlier, so a slow Cloudflare or database read can't starve the alert rules (I10).
export const ALERTS_RESERVE_MS = 3_000;

export function taskFits(task: TaskName, deadline: number, now: number): boolean {
  return deadline - now >= (MIN_LEFT_MS[task] ?? 0);
}

// The tasks runCollector runs after the others and after the state refresh (settleRun), against the full deadline.
export const POST_TASKS: readonly TaskName[] = ["alerts", "digest"];
