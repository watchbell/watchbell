import { RETENTION_DAYS } from "@/lib/collector/retention";
import { TASKS, type TaskName } from "@/lib/collector/schedule";
import { NEON_FREE } from "@/lib/databases/neon";
import { FREE_SLOTS } from "@/lib/databases/supabase";
import { BUDGET_DEFAULTS, type BudgetLimits } from "@/lib/settings/budget";
import { mode } from "@/lib/mode";
import { clock, dailyRunText, dayMonth, timeZone, zoneLabel, zoneProblem } from "@/lib/time";

// Settings → Collector, Free tier budget and Retention. Pure helpers: the pages pass in what the console already reads.

// "every 1 min", "every 5 min", "every 30 min", "every 1 h", "every 6 h", "every 1 day".
export function everyText(seconds: number): string {
  if (seconds >= 86_400 && seconds % 86_400 === 0) return `every ${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`;
  if (seconds >= 3600 && seconds % 3600 === 0) return `every ${seconds / 3600} h`;
  if (seconds >= 60 && seconds % 60 === 0) return `every ${seconds / 60} min`;
  return `every ${seconds} s`;
}

const TASK_LABEL: Record<TaskName, string> = {
  heartbeats: "Heartbeat monitors: recompute from the last ping",
  checks: "HTTP uptime checks",
  vercel: "Vercel projects and deployments",
  supabase: "Supabase project status",
  supabaseUsage: "Supabase service health and traffic",
  neon: "Neon status and usage",
  firebase: "Firestore health read",
  firebaseUsage: "Firestore usage",
  extraDbs: "Turso, Upstash Redis and Cloudflare D1 status and usage",
  cloudflare: "Cloudflare zones and DNS",
  domains: "Vercel domain settings",
  tls: "TLS certificate expiry",
  rdap: "Domain expiry (RDAP)",
  eol: "Next.js end-of-life data",
  node: "Node.js security releases and end of life, for Watchbell's own runtime",
  status: "Provider status feeds",
  logs: "Copy of Vercel warning and error logs",
  pageviews: "Web Analytics page views",
  security: "Security check: Next.js versions and dependency advisories (also right after a production deploy)",
  alerts: "Alert rules and notices",
  digest: "Digest due check",
};

export type TaskScheduleRow = { task: TaskName; label: string; every: string };

export function taskScheduleRows(tasks: Record<TaskName, number> = TASKS): TaskScheduleRow[] {
  return (Object.keys(tasks) as TaskName[]).map((task) => ({ task, label: TASK_LABEL[task], every: everyText(tasks[task]) }));
}

export type RunInput = {
  id: string; startedAt: Date; trigger: string; tasks: string[]; ok: boolean | null; errorSummary: string | null; durationMs: number | null;
};
export type RunRow = { id: string; at: string; trigger: string; tasks: string; duration: string; ok: boolean | null; summary: string };

const TRIGGER: Record<string, string> = { cron_job_org: "cron-job.org", qstash: "QStash", vercel_cron: "Vercel Cron", manual: "Refresh now" };

export const truncate = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

export function durationText(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// `hide` (minor M8): the collector's error lines name databases ("keep-active/{name}: …", "supabase/{name} size: …"), so
// the page passes hideNames with the alias book. It runs before the cut, so a truncated name can't leak in part.
export function runRows(runs: RunInput[], hide: (text: string) => string = (t) => t): RunRow[] {
  return runs.map((r) => ({
    id: r.id,
    at: `${dayMonth(r.startedAt)} ${clock(r.startedAt)}`,
    trigger: TRIGGER[r.trigger] ?? r.trigger,
    tasks: r.tasks.length ? `${r.tasks.length} task${r.tasks.length === 1 ? "" : "s"}` : "none",
    duration: durationText(r.durationMs),
    ok: r.ok,
    summary: r.ok === null ? "Not finished" : r.ok ? "OK" : truncate(hide(r.errorSummary?.trim() || "Finished with problems"), 80),
  }));
}

// Free plan limits. Each is the provider's published number, re-checked on 16 Oct 2026 (stage 8, the links are in
// src/data/free-databases.ts CATALOG_SOURCES); change them here when a plan changes.
// Upstash QStash free plan: 1,000 messages a day, each retry counted as a message; 10 active schedules
// (upstash.com/docs/qstash/overall/pricing).
export const QSTASH_FREE_MESSAGES_PER_DAY = 1000;
// The watchdog is a QStash schedule that fires every 5 minutes (Connections → Schedulers), so 86,400 / 300 = 288 a day.
export const WATCHDOG_EVERY_S = 300;
export const WATCHDOG_MESSAGES_PER_DAY = 86_400 / WATCHDOG_EVERY_S;
// cron-job.org: free; the collector job runs every minute, the shortest interval, with a 30 s timeout (cron-job.org/en/faq).
export const CRON_JOB_EVERY_S = TASKS.checks;
// Vercel Hobby (vercel.com/docs/functions/usage-and-pricing): 1M function invocations, 4 h active CPU and 360 GB-h provisioned memory a month.
export const VERCEL_HOBBY_LIMIT = "1M invocations, 4 h CPU, 360 GB-h memory / month";
// Vercel Web Analytics on Hobby: 50,000 events a month across the team's projects (vercel.com/docs/analytics/limits-and-pricing).
export const WEB_ANALYTICS_FREE_EVENTS = 50_000;

export const NOT_READ = "not read yet";
// Read nowhere in the console (no usage API is used): Vercel's monthly usage and the Web Analytics event count (1.2.1).
export const NEVER_READ = "not read";

export type BudgetRow = { key: string; item: string; limit: string; use: string; pct: number | null; tone: "ok" | "warn" | "err" | "none" };

// Stage 7 (B6): the warn/alarm percentages and the published limits are the Owner's (Settings → Free tier budget).
const toneAt = (l: Pick<BudgetLimits, "warnPct" | "errPct">) => (pct: number | null): BudgetRow["tone"] =>
  (pct === null ? "none" : pct >= l.errPct ? "err" : pct >= l.warnPct ? "warn" : "ok");

const millions = (n: number) => (n >= 1_000_000 && n % 1_000_000 === 0 ? `${n / 1_000_000}M` : n.toLocaleString("en-US"));
export const vercelHobbyLimit = (l: BudgetLimits): string =>
  `${millions(l.vercelInvocations)} invocations, ${l.vercelCpuHours} h CPU, ${l.vercelMemoryGbH} GB-h memory / month`;
const round1 = (n: number) => Math.round(n * 10) / 10;
const num = (n: number) => n.toLocaleString("en-US");

export type BudgetInput = {
  slots: { account: string; used: number; total: number; planUnknown: boolean }[];
  neon: { id: string; alias: string; cu: { value: number; pct: number } | null }[];
  // Apps watched; `read` is how many Web Analytics has been read for, `enabled` how many of those have it on.
  apps: { total: number; read: number; enabled: number };
};

export function budgetRows(i: BudgetInput, limits: BudgetLimits = BUDGET_DEFAULTS): BudgetRow[] {
  const rows: BudgetRow[] = [];
  const tone = toneAt(limits);
  if (!i.slots.length) rows.push({ key: "supabase", item: "Supabase free projects", limit: `${FREE_SLOTS} active projects per account`, use: "no Supabase account connected", pct: null, tone: "none" });
  for (const s of i.slots) {
    const pct = round1((s.used / s.total) * 100);
    rows.push({
      key: `supabase-${s.account}`, item: `Supabase free projects · ${s.account}`, limit: `${s.total} active per account`,
      use: `${s.used} of ${s.total} used${s.planUnknown ? " (plan not read for every org)" : ""}`, pct, tone: tone(pct),
    });
  }
  if (!i.neon.length) rows.push({ key: "neon", item: "Neon CU-hours", limit: `${NEON_FREE.cuHours} CU-hours / month per project`, use: "no Neon project watched", pct: null, tone: "none" });
  for (const n of i.neon) {
    rows.push({
      key: `neon-${n.id}`, item: `Neon CU-hours · ${n.alias}`, limit: `${NEON_FREE.cuHours} CU-hours / month per project`,
      use: n.cu ? `${n.cu.value} CU-hours` : NOT_READ, pct: n.cu?.pct ?? null, tone: tone(n.cu?.pct ?? null),
    });
  }
  const qpct = round1((WATCHDOG_MESSAGES_PER_DAY / limits.qstashPerDay) * 100);
  rows.push({
    key: "qstash", item: "Upstash QStash messages", limit: `${num(limits.qstashPerDay)} / day`,
    use: `${WATCHDOG_MESSAGES_PER_DAY} / day (watchdog ${everyText(WATCHDOG_EVERY_S)})`, pct: qpct, tone: tone(qpct),
  });
  rows.push({
    key: "cron", item: "cron-job.org runs", limit: "1 run / min (shortest free interval)",
    use: `1 run / min (${num(86_400 / CRON_JOB_EVERY_S)} / day)`, pct: null, tone: "none",
  });
  rows.push({ key: "vercel", item: "Vercel Hobby", limit: vercelHobbyLimit(limits), use: `${NEVER_READ} (Vercel dashboard → Usage)`, pct: null, tone: "none" });
  rows.push({
    key: "analytics", item: "Vercel Web Analytics", limit: `${num(limits.webAnalyticsEvents)} events / month`,
    use: i.apps.total === 0 ? "no apps watched"
      : i.apps.read === 0 ? `${NOT_READ} · events ${NEVER_READ}`
        : `${i.apps.enabled} of ${i.apps.total} app${i.apps.total === 1 ? "" : "s"} enabled · events ${NEVER_READ}`,
    pct: null, tone: "none",
  });
  return rows;
}

export type RetentionRow = { kind: string; keeps: string; note: string };

const days = (n: number) => `${n} days`;

// What the daily job's retention step deletes, from RETENTION_DAYS (the same constants daily.ts uses).
export function retentionRows(d: Record<keyof typeof RETENTION_DAYS, number> = RETENTION_DAYS): RetentionRow[] {
  return [
    { kind: "Raw checks", keeps: days(d.checks), note: "Every HTTP check result; the hourly rollups below keep the history." },
    { kind: "Hourly rollups", keeps: days(d.rollupsHourly), note: "Uptime and response numbers per monitor and hour." },
    { kind: "Stored logs", keeps: days(d.storedLogs), note: "The copy of Vercel warning and error logs." },
    { kind: "Deployments", keeps: days(d.deployments), note: "Older ones only; the current and the previous production deployment are always kept." },
    { kind: "Events", keeps: days(d.events), note: "The activity feed." },
    { kind: "Alerts", keeps: days(d.alerts), note: "Resolved alerts only, counted from when they resolved; open alerts stay." },
    { kind: "Collector runs", keeps: days(d.collectorRuns), note: "The run history shown in the Collector tab." },
    { kind: "Advisor dismissals", keeps: days(d.recommendationDismissals), note: "A dismissal only matters for 30 days." },
  ];
}

// The daily job: 03:00 local time in self-host, Vercel Cron's 20:00 UTC in cloud (lib/time.ts dailyRunText).
export const retentionSchedule = (): string => `Cleaned daily at ${dailyRunText()}`;

const isCloud = (): boolean => {
  try {
    return mode() === "cloud";
  } catch {
    return false;
  }
};

// Settings › Collector: the zone every time is shown in, read-only (it comes from the environment, 1.1 D1). In cloud
// the daily job keeps Vercel Cron's UTC schedule (D6) and the variable is set on Vercel. A refused setting is named.
export function zoneSetting(cloud: boolean = isCloud()): { zone: string; label: string; text: string; follows: string } {
  const zone = timeZone();
  const label = zoneLabel();
  const where = cloud ? "as a Vercel environment variable and redeploy" : "in .env";
  const problem = zoneProblem();
  const text = problem
    ? `${problem} isn't a time zone; using ${zone} (${label}). Set an IANA name such as Europe/Berlin ${where}.`
    : `Time zone: ${zone} (${label}). To change it, set WATCHBELL_TIMEZONE ${where}.`;
  const follows = cloud
    ? `Times and the digest (07:00) follow it. The daily job is Vercel Cron at 20:00 UTC (${dailyRunText()}).`
    : "Times, the daily job (03:00) and the digest (07:00) follow it.";
  return { zone, label, text, follows };
}
