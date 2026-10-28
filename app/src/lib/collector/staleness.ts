export const STALE_MS = 5 * 60_000;

// The minute collector is stale when it has never run or its last finished run is older than the limit: the
// CollectorStale rule's threshold (Alerts › Rules, 3-60 min), else 5 minutes. Watchbell 1.2.5: the watchdog follows the
// rule, so a cron-job.org schedule slower than every minute (Vercel Hobby's Active CPU) doesn't make it run the
// collector itself between the scheduled runs.
export function isStale(lastMinuteRun: Date | null, now: Date, limitMs: number = STALE_MS): boolean {
  return !lastMinuteRun || now.getTime() - lastMinuteRun.getTime() > limitMs;
}

// The rule's threshold in minutes as a limit; a missing or unusable one is the 5-minute default.
export function staleLimitMs(thresholdMin: number | null | undefined): number {
  return typeof thresholdMin === "number" && Number.isFinite(thresholdMin) && thresholdMin > 0 ? thresholdMin * 60_000 : STALE_MS;
}
