import "server-only";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { monitors } from "@/db/schema";
import type { CheckResult } from "./http-check";
import { nextMonitorState } from "./rules";

export type ReadMonitor = Pick<typeof monitors.$inferSelect, "id" | "lastCheckedAt" | "state" | "failStreak" | "url" | "expectedStatus" | "bodyContains" | "jsonPath" | "jsonEquals">;

export const same = (col: Parameters<typeof eq>[0], v: string | null): SQL => (v === null ? isNull(col) : eq(col, v));

// Compare-and-set for a check result (final review I1). A result is written only while the monitor still looks as it
// did when the writer read it: same last check, state and fail streak (no other check, Resume or Edit landed in
// between) and the same address and expected status (an Edit didn't change what is being checked). The collector,
// Check now, Edit and Resume can then run side by side without a lease: whoever writes second sees 0 rows and drops
// its result, so a fail streak is never counted from a stale copy and a transition event is never written twice.
// last_checked_at is only ever written from a JS Date (millisecond precision), so equality on it is exact.
export function unchangedSince(m: ReadMonitor) {
  return and(
    eq(monitors.id, m.id),
    m.lastCheckedAt === null ? isNull(monitors.lastCheckedAt) : eq(monitors.lastCheckedAt, m.lastCheckedAt),
    eq(monitors.state, m.state),
    eq(monitors.failStreak, m.failStreak),
    eq(monitors.url, m.url),
    eq(monitors.expectedStatus, m.expectedStatus),
    same(monitors.bodyContains, m.bodyContains),
    same(monitors.jsonPath, m.jsonPath),
    same(monitors.jsonEquals, m.jsonEquals),
  );
}

// Writes one check result onto the monitor it was read from. false: someone else changed the monitor first (or it
// was deleted), so the caller writes no checks row and no event for this result.
export async function writeCheckResult(m: ReadMonitor, r: CheckResult, now: Date): Promise<boolean> {
  const next = nextMonitorState(m.failStreak, r);
  const rows = await db().update(monitors).set({
    state: next.state, failStreak: next.failStreak, lastCheckedAt: now, lastStatus: r.statusCode, lastLatencyMs: r.latencyMs, lastError: r.error,
    ...(next.state !== m.state ? { stateSince: now } : {}), updatedAt: now,
  }).where(unchangedSince(m)).returning({ id: monitors.id });
  return rows.length > 0;
}
