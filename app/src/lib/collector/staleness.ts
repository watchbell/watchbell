export const STALE_MS = 5 * 60_000;

// The minute collector is stale when it has never run or its last finished run is more than 5 minutes old.
export function isStale(lastMinuteRun: Date | null, now: Date): boolean {
  return !lastMinuteRun || now.getTime() - lastMinuteRun.getTime() > STALE_MS;
}
