import type { State } from "@/lib/status";
import { dayKey } from "@/lib/time";

export type SummaryCounts = { ok: number; warn: number; err: number; maint: number; paused: number };

// The cards at the top of Uptime. `state` is what monitorStatus shows for the monitor (heartbeats included). A monitor the
// owner paused ("paused") or whose app is not watched ("off") is Paused, so no monitor goes uncounted; one whose app is
// gone from Vercel is removed, not paused, and is left out. "unknown" (waiting for a first check) has no card.
export function summaryCounts(rows: { state: State; appGone?: boolean }[]): SummaryCounts {
  const out: SummaryCounts = { ok: 0, warn: 0, err: 0, maint: 0, paused: 0 };
  for (const r of rows) {
    if (r.appGone) continue;
    if (r.state === "ok" || r.state === "warn" || r.state === "err" || r.state === "maint") out[r.state]++;
    else if (r.state === "paused" || r.state === "off") out.paused++;
  }
  return out;
}

// `checks` and `failures` leave out the checks made inside a maintenance window; `maint` counts those (U5).
export type DayCount = { day: string; checks: number; failures: number; maint: number };
export type MonitorDay = DayCount & { monitorId: string };
export type Tone = "none" | "ok" | "warn" | "err" | "maint";
export type Bar = { day: string; tone: Tone; title: string; deploy?: string };

export const BAR_DAYS = 90;
export const UPTIME_DAYS = 30;

// R3: days are local calendar days ("2026-10-13") in the configured zone: lib/time.ts dayKey and dayStart.

// The last n local days, oldest first, ending today. Calendar maths on the date itself, so month ends just work.
export function dayKeys(now: Date, n: number): string[] {
  const [y, m, d] = dayKey(now).split("-").map(Number);
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1, d - (n - 1 - i))).toISOString().slice(0, 10));
}

// R3: no data grey, no failures green, 1–2 failures amber, 3 or more red (as "down after 3"). U5: a day with only
// maintenance checks is maintenance (blue), not grey; one with counted checks too takes their colour.
export function dayTone(c: { checks: number; failures: number; maint?: number } | undefined): Tone {
  if (!c || (c.checks === 0 && !c.maint)) return "none";
  if (c.checks === 0) return "maint";
  if (c.failures === 0) return "ok";
  return c.failures < 3 ? "warn" : "err";
}

// Rollup rows and raw-check rows can cover the same day (the day the rollups stop): they are added up.
export function mergeDays(rows: MonitorDay[]): Map<string, Map<string, DayCount>> {
  const out = new Map<string, Map<string, DayCount>>();
  for (const r of rows) {
    let days = out.get(r.monitorId);
    if (!days) {
      days = new Map();
      out.set(r.monitorId, days);
    }
    const prev = days.get(r.day);
    days.set(r.day, { day: r.day, checks: (prev?.checks ?? 0) + r.checks, failures: (prev?.failures ?? 0) + r.failures, maint: (prev?.maint ?? 0) + (r.maint ?? 0) });
  }
  return out;
}

const agoLabel = (n: number) => (n === 0 ? "Today" : n === 1 ? "1 day ago" : `${n} days ago`);

// The 90-bar strip: oldest left, newest right, each with a tooltip. `deploys` (local day → commits, A1) marks the days
// that had a production deploy and names them in the tooltip.
export function uptimeBars(days: Map<string, DayCount> | undefined, now: Date, n = BAR_DAYS, deploys?: Map<string, string>): Bar[] {
  return dayKeys(now, n).map((day, i) => {
    const c = days?.get(day);
    const tone = dayTone(c);
    const when = agoLabel(n - 1 - i);
    const deploy = deploys?.get(day);
    const title = !c || tone === "none" ? `${when} · no data` : tone === "maint" ? `${when} · maintenance, not counted` : `${when} · ${c.failures} failed of ${c.checks}`;
    return { day, tone, title: deploy ? `${title} · deployed ${deploy}` : title, deploy };
  });
}

export function lastDays(days: Map<string, DayCount> | undefined, now: Date, n: number): (DayCount | undefined)[] {
  return dayKeys(now, n).map((d) => days?.get(d));
}

// R3: (checks − failures) / checks over the window, as a percentage. Null without checks.
export function uptimePct(list: (DayCount | undefined)[]): number | null {
  let checks = 0;
  let failures = 0;
  for (const c of list) {
    if (!c) continue;
    checks += c.checks;
    failures += c.failures;
  }
  return checks ? ((checks - failures) / checks) * 100 : null;
}

// Same origin as `date_bin(…, timestamptz '2000-01-01 00:00:00+00')` in metrics-db.
export const BIN_ORIGIN = Date.UTC(2000, 0, 1);

// The first of n buckets that end with the bucket holding `now`.
export function firstBucket(now: Date, sizeMs: number, n: number): number {
  const current = BIN_ORIGIN + Math.floor((now.getTime() - BIN_ORIGIN) / sizeMs) * sizeMs;
  return current - (n - 1) * sizeMs;
}

// Places SQL rows (bucket start in epoch ms) into n slots. Empty slots are null, or `fill` for counts.
export function series(rows: { t: number; v: number | null }[], first: number, sizeMs: number, n: number, fill: number | null = null): (number | null)[] {
  const out: (number | null)[] = Array.from({ length: n }, () => fill);
  for (const r of rows) {
    const i = Math.round((r.t - first) / sizeMs);
    if (i >= 0 && i < n) out[i] = r.v;
  }
  return out;
}
