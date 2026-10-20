export const STATES = ["ok", "warn", "err", "idle", "build", "paused", "info", "fail", "off", "unknown", "maint"] as const;
export type State = (typeof STATES)[number];

// Icon colour per state, as in the mockup (.st-*).
export const STATE_TONE: Record<State, string> = {
  ok: "text-ok",
  warn: "text-warn-icon",
  paused: "text-warn-icon",
  err: "text-err",
  fail: "text-err",
  idle: "text-idle",
  off: "text-idle",
  unknown: "text-idle",
  build: "text-brand",
  info: "text-brand",
  maint: "text-brand",
};

export function clampPct(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(100, Math.max(0, n));
}
