import { readEnv } from "@/lib/brand-env";

// Vercel Hobby (28 Oct): 4 h of Active CPU a month, about 8 minutes a day. A collector run every minute used 10-15
// minutes a day and the team ran out, so the scheduled endpoint has a floor between runs and the collector counts the
// CPU its runs use per day. Pure helpers; the database side is in cpu-budget-db.ts.

// A scheduled call (cron-job.org) sooner than this after the last run is answered without running: a schedule set back
// to every minute by mistake can't burn the month's CPU again. WATCHBELL_COLLECT_MIN_GAP_MIN (or the old WATCHPOST_
// name), minutes, 0 turns it off. Refresh now and the watchdog are not scheduled calls and always run.
export const DEFAULT_MIN_GAP_MIN = 10;

export function collectMinGapMs(source: Record<string, string | undefined> = process.env): number {
  const raw = (readEnv(source, "COLLECT_MIN_GAP_MIN") ?? "").trim();
  const n = raw === "" ? DEFAULT_MIN_GAP_MIN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * 60_000 : DEFAULT_MIN_GAP_MIN * 60_000;
}

export function tooSoon(lastRun: Date | null, now: Date, gapMs: number): boolean {
  return gapMs > 0 && lastRun !== null && now.getTime() - lastRun.getTime() < gapMs;
}

// Half of a Hobby day's share: past it, one warning event that day.
export const CPU_DAY_WARN_MS = 4 * 60_000;

export type CpuDay = { day: string; ms: number; runs: number; warned: boolean };

// The day's total after one more run (a new UTC day starts at zero), and whether this run is the one that crossed
// the warning line.
export function addRunCpu(prev: unknown, ms: number, now: Date): { next: CpuDay; crossed: boolean } {
  const day = now.toISOString().slice(0, 10);
  const p = prev && typeof prev === "object" ? (prev as Partial<CpuDay>) : {};
  const same = p.day === day && Number.isFinite(p.ms) && Number.isFinite(p.runs);
  const base: CpuDay = same ? { day, ms: p.ms as number, runs: p.runs as number, warned: p.warned === true } : { day, ms: 0, runs: 0, warned: false };
  const add = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
  const next: CpuDay = { ...base, ms: base.ms + add, runs: base.runs + 1 };
  const crossed = !base.warned && next.ms > CPU_DAY_WARN_MS;
  if (crossed) next.warned = true;
  return { next, crossed };
}
