// Stage 6 A8: the owner's opt-in Keep active and Auto-restore for Supabase projects (never Neon). Pure decisions; the
// daily job (keep-alive) and the 5-minute status task (auto-restore) act on them in lib/data/keep-active-db.ts.
const DAY = 86_400_000;
export const KEEP_ALIVE_AFTER_DAYS = 5;
export const AUTO_RESTORE_EVERY_MS = 6 * 3600_000;
// The audit message of a console Pause (supabase/actions.ts). Auto-restore leaves a project alone after one of these
// that is newer than the owner's last tick, so it never takes back a slot a member freed on purpose.
export const PAUSE_REQUESTED = "Pause requested · ";

// One keep-alive a day for a kept, active healthy project with no API traffic for 5 days. Traffic that was never read
// counts from when the console started tracking the project.
export function keepAliveDue(p: { status: string; keep: boolean; lastTraffic: Date | null; trackedSince: Date }, now: Date): boolean {
  if (!p.keep || p.status !== "ACTIVE_HEALTHY") return false;
  const since = p.lastTraffic ?? p.trackedSince;
  return now.getTime() - since.getTime() >= KEEP_ALIVE_AFTER_DAYS * DAY;
}

// Restore a paused project only with a free slot right now, at most once per 6 h, and never after the token was
// refused write access (until the credential is replaced or the owner ticks the box again).
export function autoRestoreDecision(
  p: { status: string; autoRestore: boolean; lastAutoRestoreAt: Date | null; slotsLeft: number; accessDenied: boolean },
  now: Date,
): { act: true } | { act: false; reason: "off" | "not-paused" | "too-soon" | "no-slot" | "denied" } {
  if (!p.autoRestore) return { act: false, reason: "off" };
  if (p.status !== "INACTIVE") return { act: false, reason: "not-paused" };
  if (p.accessDenied) return { act: false, reason: "denied" };
  if (p.lastAutoRestoreAt && now.getTime() - p.lastAutoRestoreAt.getTime() < AUTO_RESTORE_EVERY_MS) return { act: false, reason: "too-soon" };
  if (p.slotsLeft <= 0) return { act: false, reason: "no-slot" };
  return { act: true };
}
