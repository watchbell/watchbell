// Owner, 13 Oct 2026: every 60 s. The collector changes the data once a minute, so polling faster only re-rendered the
// same rows.
export const REFRESH_MS = 60_000;
// Final review I4: a tab nobody has touched for 30 minutes (a console left open on a second screen) polls four times
// slower, every 4 minutes (it was 15 s and 60 s; the ratio stays).
export const IDLE_AFTER_MS = 30 * 60_000;
export const IDLE_REFRESH_MS = 4 * REFRESH_MS;
// A refresh still outstanding after this long is taken as lost, and a new one may be sent.
export const STUCK_MS = 60_000;

export type RefreshClock = {
  visible: boolean; held: boolean; online: boolean; pending: boolean;
  lastAt: number; requestedAt: number; lastInputAt: number; now: number;
  // A page that waits on something quicker than the collector (AI › Ask while a question waits: 15 s) asks for a
  // shorter period. Idle still wins: an untouched tab polls every 4 minutes whatever the page asked for.
  period?: number;
};

export const isIdle = (lastInputAt: number, now: number): boolean => now - lastInputAt >= IDLE_AFTER_MS;

export const refreshPeriod = (lastInputAt: number, now: number): number => (isIdle(lastInputAt, now) ? IDLE_REFRESH_MS : REFRESH_MS);

// R1: refresh every 60 s (4 min when idle) while the tab is visible, online, and nothing holds the page (an open dialog
// or menu). A refresh in flight is never replaced by a newer one: a page whose render takes longer than the period
// would otherwise have each refresh cancelled by the next and never update. Only one that has been outstanding for
// STUCK_MS is given up on. When a refresh finished without new data, the next one waits a whole period.
export function refreshDue(c: RefreshClock): boolean {
  if (!c.visible || c.held || !c.online) return false;
  const period = c.period && !isIdle(c.lastInputAt, c.now) ? Math.min(c.period, REFRESH_MS) : refreshPeriod(c.lastInputAt, c.now);
  if (c.now - c.lastAt < period) return false;
  if (c.pending) return c.now - c.requestedAt >= STUCK_MS;
  return c.requestedAt <= c.lastAt || c.now - c.requestedAt >= period;
}

// Coming back to the tab, or back online (final review I2): refresh right away, unless a refresh is already on its way.
export function refreshOnReturn(c: Pick<RefreshClock, "visible" | "held" | "online" | "pending" | "lastAt" | "requestedAt">): boolean {
  return c.visible && !c.held && c.online && !c.pending && c.requestedAt <= c.lastAt;
}

// Top bar live indicator (mockup section 8).
export function liveText(lastAt: number, now: number, idle = false): string {
  return `Updated ${Math.max(0, Math.floor((now - lastAt) / 1000))}s ago · ${idle ? "every 4 min (idle)" : "every 60s"}`;
}

// The console's error screen retries on its own (final review I2): after 15 s, then 22.5 s, then every 30 s.
export function retryDelay(attempt: number): number {
  return Math.min(30_000, Math.round(15_000 * 1.5 ** Math.max(0, attempt)));
}
