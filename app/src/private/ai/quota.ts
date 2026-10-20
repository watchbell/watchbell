import type { ProviderKind, QuotaObservation } from "@/private/ai/types";

// Quota (pure). Two sources: what a provider says in its rate-limit headers ("header"), and Watchbell's own counts of
// the calls it forwards against limits the owner enters ("own"; Gemini sends no headers). Grouped for the Quota page
// like Antigravity's "View usage": one group per provider and model family, one row per window.

export type Window = "minute" | "day" | "week";
export type OwnLimit = { metric: string; scope: string; limit: number; window: Window };
export type StoredQuota = {
  providerId: string; scope: string; metric: string; windowStart: Date | null; used: number | null; limit: number | null;
  remaining: number | null; resetAt: Date | null; source: string; updatedAt?: Date;
};
export type QuotaConnection = { id: string; kind: ProviderKind; name: string; limits: OwnLimit[] };
export type QuotaRow = { label: string; pctLeft: number; resetsIn: string; source: "header" | "own"; used: number | null; limit: number | null; limited: boolean };
export type QuotaGroup = { group: string; provider: ProviderKind; providerId: string; rows: QuotaRow[] };

const MIN = 60_000;
const DAY = 86_400_000;

// Day and week windows reset at 00:00 UTC (the week on Monday), like the providers' own daily quotas.
export function windowBounds(window: Window, now: Date): { start: Date; end: Date } {
  const t = now.getTime();
  if (window === "minute") {
    const start = Math.floor(t / MIN) * MIN;
    return { start: new Date(start), end: new Date(start + MIN) };
  }
  const day = Math.floor(t / DAY) * DAY;
  if (window === "day") return { start: new Date(day), end: new Date(day + DAY) };
  const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
  const start = day - dow * DAY;
  return { start: new Date(start), end: new Date(start + 7 * DAY) };
}

export function ownWindows(limits: OwnLimit[], now: Date): (OwnLimit & { start: Date; resetAt: Date })[] {
  return limits.map((l) => {
    const b = windowBounds(l.window, now);
    return { ...l, start: b.start, resetAt: b.end };
  });
}

// One observation per owner-entered limit that this call counts against (requests count 1, tokens count in + out).
// recordCall adds `used` to the stored row while the window is the same, and starts over in a new window.
export function ownObservations(providerId: string, limits: OwnLimit[], model: string | null, tokens: number | null, now: Date): QuotaObservation[] {
  const out: QuotaObservation[] = [];
  for (const w of ownWindows(limits, now)) {
    if (w.scope !== "all" && w.scope !== model) continue;
    const used = w.metric === "tokens" ? tokens ?? 0 : 1;
    out.push({ providerId, scope: w.scope, metric: `${w.metric}:${w.window}`, limit: w.limit, remaining: null, used, resetAt: w.resetAt, source: "own" });
  }
  return out;
}

export function formatResetsIn(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const WINDOW_LABEL: Record<string, string> = { minute: "Per-minute", day: "Daily", week: "Weekly" };
const METRIC_LABEL: Record<string, string> = { requests: "request", tokens: "token" };

function label(metric: string, source: "header" | "own"): string {
  // own: "requests:day"; header: "requests:minute" (Groq-style headers are per minute/day as the provider says).
  const [what, window] = metric.split(":");
  const base = `${WINDOW_LABEL[window] ?? "Current"} ${METRIC_LABEL[what] ?? what} limit`;
  return source === "own" ? `${base} (you entered)` : base;
}

// A row is used up when nothing is left and its window hasn't reset yet.
export function isLimited(row: Pick<StoredQuota, "used" | "limit" | "remaining" | "resetAt">, now: Date): boolean {
  if (row.resetAt && row.resetAt.getTime() <= now.getTime()) return false;
  if (row.remaining !== null) return row.remaining <= 0;
  return row.limit !== null && row.used !== null && row.used >= row.limit;
}

function pctLeft(r: StoredQuota): number {
  if (r.limit === null || r.limit <= 0) return 100;
  const left = r.remaining !== null ? r.remaining : r.limit - (r.used ?? 0);
  return Math.max(0, Math.min(100, Math.round((left / r.limit) * 100)));
}

export function quotaGroups(stored: StoredQuota[], conns: QuotaConnection[], now: Date): QuotaGroup[] {
  const groups = new Map<string, QuotaGroup>();
  for (const c of conns) {
    const rows = stored.filter((s) => s.providerId === c.id);
    // Owner-entered limits with no call yet still show (100 % left).
    for (const w of ownWindows(c.limits, now)) {
      const metric = `${w.metric}:${w.window}`;
      if (!rows.some((r) => r.source === "own" && r.scope === w.scope && r.metric === metric)) {
        rows.push({ providerId: c.id, scope: w.scope, metric, windowStart: w.start, used: 0, limit: w.limit, remaining: null, resetAt: w.resetAt, source: "own" });
      }
    }
    for (const r of rows) {
      const source = r.source === "header" ? "header" : "own";
      // An own row from an earlier window has reset: nothing used in this one yet.
      const stale = source === "own" && r.resetAt !== null && r.resetAt.getTime() <= now.getTime();
      const own = c.limits.find((l) => `${l.metric}:${l.window}` === r.metric && l.scope === r.scope);
      const cur: StoredQuota = stale
        ? { ...r, used: 0, resetAt: own ? windowBounds(own.window, now).end : null }
        : { ...r, limit: source === "own" && own ? own.limit : r.limit };
      if (source === "own" && !own) continue; // a limit the owner removed
      const key = `${c.id}|${r.scope}`;
      const g = groups.get(key) ?? { group: `${c.name} · ${r.scope === "all" ? "all models" : r.scope}`, provider: c.kind, providerId: c.id, rows: [] };
      g.rows.push({
        label: label(r.metric, source), pctLeft: pctLeft(cur), source,
        resetsIn: cur.resetAt ? formatResetsIn(cur.resetAt.getTime() - now.getTime()) : "—",
        used: cur.used, limit: cur.limit, limited: isLimited(cur, now),
      });
      groups.set(key, g);
    }
  }
  return [...groups.values()];
}
