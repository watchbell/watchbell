// Owner, 13 Oct 2026: every 60 s. The collector changes the data once a minute, so polling faster only re-rendered the
// same rows.
export const REFRESH_MS = 60_000;
// Final review I4: a tab nobody has touched for 30 minutes (a console left open on a second screen) polls four times
// slower, every 4 minutes (it was 15 s and 60 s; the ratio stays).
export const IDLE_AFTER_MS = 30 * 60_000;
export const IDLE_REFRESH_MS = 4 * REFRESH_MS;
// A refresh still outstanding after this long is taken as lost, and a new one may be sent.
export const STUCK_MS = 60_000;

// 1.2.3 (owner 24 Oct, Grafana-like): the top bar's refresh picker, kept per browser. Auto (the default) refreshes
// right after each collector run; nothing faster than a minute, since the data changes once a minute and every
// refresh is a Vercel invocation and a slot of the database pool.
export type RefreshChoice = "off" | "auto" | "1m" | "5m" | "15m" | "30m";
export const REFRESH_CHOICES: { id: RefreshChoice; label: string; ms: number | null }[] = [
  { id: "off", label: "Off", ms: null },
  { id: "auto", label: "Auto · after each check", ms: null },
  { id: "1m", label: "Every minute", ms: 60_000 },
  { id: "5m", label: "Every 5 minutes", ms: 5 * 60_000 },
  { id: "15m", label: "Every 15 minutes", ms: 15 * 60_000 },
  { id: "30m", label: "Every 30 minutes", ms: 30 * 60_000 },
];
export const REFRESH_CHOICE_KEY = "oc-refresh";
export const parseRefreshChoice = (raw: string | null | undefined): RefreshChoice =>
  REFRESH_CHOICES.find((c) => c.id === raw)?.id ?? "auto";
// A collector run older than this means it stopped (or this is the demo): Auto then refreshes every 60 s.
export const AUTO_STALE_MS = 3 * 60_000;

export type RefreshClock = {
  visible: boolean; held: boolean; online: boolean; pending: boolean;
  lastAt: number; requestedAt: number; lastInputAt: number; now: number;
  // A page that waits on something quicker than the collector (AI › Ask while a question waits: 15 s) asks for a
  // shorter period. Idle still wins: an untouched tab polls every 4 minutes whatever the page asked for.
  period?: number;
  // The picker (left out: the old every-60-s behaviour) and, for Auto, when the collector last ran (null: unknown).
  choice?: RefreshChoice;
  collectorRunAt?: number | null;
};

export const isIdle = (lastInputAt: number, now: number): boolean => now - lastInputAt >= IDLE_AFTER_MS;

export const refreshPeriod = (lastInputAt: number, now: number): number => (isIdle(lastInputAt, now) ? IDLE_REFRESH_MS : REFRESH_MS);

// R1: refresh every 60 s (4 min when idle) while the tab is visible, online, and nothing holds the page (an open dialog
// or menu). A refresh in flight is never replaced by a newer one: a page whose render takes longer than the period
// would otherwise have each refresh cancelled by the next and never update. Only one that has been outstanding for
// STUCK_MS is given up on. When a refresh finished without new data, the next one waits a whole period.
export function refreshDue(c: RefreshClock): boolean {
  if (!c.visible || c.held || !c.online || c.choice === "off") return false;
  const idle = isIdle(c.lastInputAt, c.now);
  // Auto with a live collector: due once a run newer than the page's data is known (idle: not more often than 4 min).
  const auto = c.choice === "auto" && c.collectorRunAt != null && c.now - c.collectorRunAt < AUTO_STALE_MS;
  if (auto && !c.period) {
    if (c.collectorRunAt! <= c.lastAt || (idle && c.now - c.lastAt < IDLE_REFRESH_MS)) return false;
    if (c.pending) return c.now - c.requestedAt >= STUCK_MS;
    return c.requestedAt <= c.lastAt || c.now - c.requestedAt >= REFRESH_MS;
  }
  const chosen = REFRESH_CHOICES.find((x) => x.id === c.choice)?.ms ?? REFRESH_MS;
  const base = idle ? Math.max(chosen, IDLE_REFRESH_MS) : chosen;
  const period = c.period && !idle ? Math.min(c.period, base) : base;
  if (c.now - c.lastAt < period) return false;
  if (c.pending) return c.now - c.requestedAt >= STUCK_MS;
  return c.requestedAt <= c.lastAt || c.now - c.requestedAt >= period;
}

// Coming back to the tab, or back online (final review I2): refresh right away, unless a refresh is already on its way
// or the picker is Off.
export function refreshOnReturn(c: Pick<RefreshClock, "visible" | "held" | "online" | "pending" | "lastAt" | "requestedAt" | "choice">): boolean {
  return c.choice !== "off" && c.visible && !c.held && c.online && !c.pending && c.requestedAt <= c.lastAt;
}

// Top bar live indicator (mockup section 8). Seconds for the first two minutes, then minutes.
export function liveText(lastAt: number, now: number, idle = false, choice?: RefreshChoice): string {
  const s = Math.max(0, Math.floor((now - lastAt) / 1000));
  const ago = s < 120 ? `${s}s ago` : `${Math.floor(s / 60)} min ago`;
  const minutes = (REFRESH_CHOICES.find((x) => x.id === choice)?.ms ?? 0) / 60_000;
  const how = choice === "off" ? "Off"
    : idle ? "every 4 min (idle)"
    : choice === "auto" ? "Auto · after each check"
    : minutes ? `every ${minutes === 1 ? "minute" : `${minutes} min`}`
    : "every 60s";
  return `Updated ${ago} · ${how}`;
}

// The console's error screen retries on its own (final review I2): after 15 s, then 22.5 s, then every 30 s.
export function retryDelay(attempt: number): number {
  return Math.min(30_000, Math.round(15_000 * 1.5 ** Math.max(0, attempt)));
}
