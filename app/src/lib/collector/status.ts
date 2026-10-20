import { ago } from "@/lib/time";

// Demo mode has no collector (no provider is ever called): the sidebar footer and Overview's Collector cell say so
// instead of turning late and then stopped.
export const DEMO_COLLECTOR_TEXT = "Demo · no live collector";

// Sidebar footer. The mockup only shows the healthy text; amber after 2 minutes and red after 5 match CollectorStale.
export function collectorHealth(lastRunAt: Date | null, now: Date): { state: "ok" | "warn" | "err" | "idle"; text: string } {
  if (!lastRunAt) return { state: "idle", text: "Collector hasn't run yet" };
  const s = Math.max(0, Math.round((now.getTime() - lastRunAt.getTime()) / 1000));
  const min = Math.floor(s / 60);
  if (s < 60) return { state: "ok", text: `Collector ran ${s}s ago` };
  if (s < 120) return { state: "ok", text: `Collector ran ${min} min ago` };
  if (s < 300) return { state: "warn", text: `Collector late · ran ${min} min ago` };
  return { state: "err", text: `Collector stopped ${min} min ago` };
}

const RUNNING_MS = 120_000;

// Connections → Schedulers, for the cron-job.org and Vercel Cron rows: what the last run of that trigger says.
// Ages count from when the run finished, or from when it started while it hasn't.
export function schedulerRun(
  run: { startedAt: Date; finishedAt: Date | null; ok: boolean | null },
  now: Date,
  lateMs: number,
): { state: "ok" | "warn" | "err" | "build"; text: string } {
  if (!run.finishedAt) {
    return now.getTime() - run.startedAt.getTime() < RUNNING_MS
      ? { state: "build", text: "Running now" }
      : { state: "err", text: `Last run didn't finish (started ${ago(run.startedAt, now)})` };
  }
  const when = ago(run.finishedAt, now);
  if (run.ok === false) return { state: "warn", text: `Last run ${when} · finished with problems` };
  if (now.getTime() - run.finishedAt.getTime() >= lateMs) return { state: "warn", text: `Last run ${when} · late` };
  return { state: "ok", text: `Last run ${when}` };
}
