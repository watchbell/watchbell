// Page views (Vercel Web Analytics) as the collector stores them in ops.snapshots.data.pageviews and as the app's
// Metrics card shows them. Pure: no database, no clock.
import type { PageViews } from "@/lib/providers/vercel-analytics";
import { clock } from "@/lib/time";

const HOUR = 3_600_000;
export const PAGEVIEW_HOURS = 24;

// The stored shape: hourly is [ISO hour, views] pairs, at most 24, only hours Vercel reported.
export type StoredPageViews =
  | { enabled: false; readAt: string }
  | { enabled: true; total24h: number; visitors24h: number | null; hourly: [string, number][]; readAt: string };

export function storedPageViews(r: Extract<PageViews, { ok: true }>, readAt: Date): StoredPageViews {
  if (!r.enabled) return { enabled: false, readAt: readAt.toISOString() };
  return {
    enabled: true, total24h: r.total, visitors24h: r.visitors, readAt: readAt.toISOString(),
    hourly: r.hourly.slice(-PAGEVIEW_HOURS).map((h) => [h.at.toISOString(), h.views]),
  };
}

// What the card draws: always 24 hourly slots, oldest first, the last one the hour of the read; an hour Vercel didn't
// report had no views (0).
export type PageViewsView =
  | { enabled: false; readAt: Date }
  | { enabled: true; total: number; visitors: number | null; hours: { at: Date; views: number }[]; readAt: Date };

const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

// `data` is the snapshot's jsonb. Anything that isn't the stored shape reads as "not read yet" (null).
export function pageViewsOf(data: unknown): PageViewsView | null {
  const raw = data && typeof data === "object" ? (data as Record<string, unknown>).pageviews : null;
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const readAt = typeof p.readAt === "string" ? Date.parse(p.readAt) : NaN;
  if (Number.isNaN(readAt) || typeof p.enabled !== "boolean") return null;
  if (!p.enabled) return { enabled: false, readAt: new Date(readAt) };
  const total = count(p.total24h);
  // null visitors: the read had no unique-visitor count (see readPageViews); anything else that isn't a count is unreadable.
  const visitors = p.visitors24h === null ? null : count(p.visitors24h);
  if (total === null || (visitors === null && p.visitors24h !== null)) return null;
  const last = Math.floor(readAt / HOUR) * HOUR;
  const byHour = new Map<number, number>();
  for (const e of Array.isArray(p.hourly) ? p.hourly : []) {
    if (!Array.isArray(e)) continue;
    const t = typeof e[0] === "string" ? Date.parse(e[0]) : NaN;
    const n = count(e[1]);
    if (Number.isNaN(t) || n === null) continue;
    const hour = Math.floor(t / HOUR) * HOUR;
    byHour.set(hour, (byHour.get(hour) ?? 0) + n);
  }
  const hours = Array.from({ length: PAGEVIEW_HOURS }, (_, i) => {
    const t = last - (PAGEVIEW_HOURS - 1 - i) * HOUR;
    return { at: new Date(t), views: byHour.get(t) ?? 0 };
  });
  return { enabled: true, total, visitors, hours, readAt: new Date(readAt) };
}

// One bar per hour, as a percentage of the busiest hour. An hour with any views is at least 4% tall, so a quiet hour
// is still visible next to a busy one; an hour with none is 0 (the chart draws a thin baseline there).
export function pageViewBars(hours: { at: Date; views: number }[]): { key: string; pct: number; title: string }[] {
  const max = Math.max(0, ...hours.map((h) => h.views));
  return hours.map((h) => ({
    key: h.at.toISOString(),
    pct: h.views === 0 || max === 0 ? 0 : Math.max(4, Math.round((h.views / max) * 100)),
    title: `${clock(h.at)} · ${h.views} view${h.views === 1 ? "" : "s"}`,
  }));
}

// The last good read is shown as it is, but once it is older than this the card says when it was read. Reads run every 30
// minutes, so two hours is four missed reads in a row.
export const STALE_MS = 2 * HOUR;
export const isStale = (readAt: Date, now: Date): boolean => now.getTime() - readAt.getTime() > STALE_MS;

// Why an app is never read by the `pageviews` task (it reads the apps logs-db's targets() gives: watched, in a connected
// Vercel account with a team id, with a production deployment); null when it would be read. The data layer calls this
// with what it knows, the card shows the text instead of "Reading page views…" forever.
export function pageViewsUnavailable(a: { gone: boolean; teamId: string | null; accountOk: boolean; hasProductionDeploy: boolean }): string | null {
  if (a.gone || !a.teamId || !a.accountOk) return "Not read: this app isn't in a connected Vercel account.";
  if (!a.hasProductionDeploy) return "Not read: this app has no production deployment yet.";
  return null;
}
