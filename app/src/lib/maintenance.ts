// U5 / B3. Checks keep running inside a maintenance window and are stored with in_maintenance = true: they are left
// out of uptime % and open no alerts. A weekly window repeats at the same local wall time (lib/time.ts), so across a
// daylight-saving change it is 7 × 24 h ± 1 h after the previous one; in WIB (no daylight saving) always exactly 7 × 24 h.
// Pure: the collector, the alert evaluation, Check now and the Uptime page all decide with these functions.
import { isUuid } from "@/lib/ids";
import type { State } from "@/lib/status";
import { addLocalDays, clock, dayMonth, fromLocalInput, zonedParts } from "@/lib/time";

export type Window = { id: string; scope: "all" | "app" | "monitor"; appId: string | null; monitorId: string | null; startsAt: Date; durationMin: number; weekly: boolean; note: string | null };
export type Target = { monitorId: string; appId: string };
export const MAX_WINDOWS = 20;
export const DURATIONS_MIN = [30, 60, 90, 180, 360] as const;
export const NOTE_MAX = 120;
const WEEK = 7 * 86_400_000;

const span = (start: number, w: Window) => ({ start: new Date(start), end: new Date(start + w.durationMin * 60_000) });

// The start of a weekly window's k-th repeat: the same local wall time 7k days later.
const weekStart = (w: Window, k: number): number => (k === 0 ? w.startsAt.getTime() : addLocalDays(w.startsAt, 7 * k).getTime());

// The last repeat that started at or before t (t >= startsAt): its number k and its start. A repeat is at most an
// hour or two off 7 × 24 h, so the plain division is right or one off either way.
function lastWeek(w: Window, t: number): { k: number; start: number } {
  let k = Math.floor((t - w.startsAt.getTime()) / WEEK);
  let s = weekStart(w, k);
  while (k > 0 && s > t) s = weekStart(w, --k);
  for (let next = weekStart(w, k + 1); next <= t; next = weekStart(w, k + 1)) {
    k++;
    s = next;
  }
  return { k, start: s };
}

// The occurrence that covers `now` (start inclusive, end exclusive), or null.
export function occurrence(w: Window, now: Date): { start: Date; end: Date } | null {
  const t = now.getTime();
  const s = w.startsAt.getTime();
  if (t < s) return null;
  const o = span(w.weekly ? lastWeek(w, t).start : s, w);
  return t < o.end.getTime() ? o : null;
}

// The occurrence covering `now`, else the next one; null when a one-off is over.
export function nextOccurrence(w: Window, now: Date): { start: Date; end: Date } | null {
  const cur = occurrence(w, now);
  if (cur) return cur;
  const t = now.getTime();
  const s = w.startsAt.getTime();
  if (t < s) return span(s, w);
  if (!w.weekly) return null;
  // Counted from the stored start, never from the last repeat: a repeat the spring-forward gap moved (02:30 → 03:30)
  // must not move the ones after it.
  const last = lastWeek(w, t);
  return span(last.start === t ? last.start : weekStart(w, last.k + 1), w);
}

export function covers(w: Window, t: Target): boolean {
  return w.scope === "all" || (w.scope === "app" && w.appId === t.appId) || (w.scope === "monitor" && w.monitorId === t.monitorId);
}

// The window a monitor is inside right now. When two overlap, the one that ends last, so "until HH:MM" is true.
export function activeFor(ws: Window[], t: Target, now: Date): { window: Window; end: Date } | null {
  let best: { window: Window; end: Date } | null = null;
  for (const w of ws) {
    const o = covers(w, t) ? occurrence(w, now) : null;
    if (o && (!best || o.end > best.end)) best = { window: w, end: o.end };
  }
  return best;
}

// PlanContext.maintenance: the monitors inside a window right now, plus the apps a whole-app or all-monitors window
// covers (an app-level rule such as a failed deployment is then held back too). A whole-app window adds its app even
// when the app has no active monitor, and an all-monitors window adds every app in `appIds` (review M2). A window on
// one monitor adds only that monitor: its app's id would also mute the app's other monitors, whose alerts carry the
// app as their resource.
export function maintenanceSet(ws: Window[], monitors: { id: string; appId: string }[], now: Date, appIds: string[] = []): Set<string> {
  const out = new Set<string>();
  const live = ws.filter((w) => occurrence(w, now) !== null);
  for (const w of live) {
    if (w.scope === "app" && w.appId) out.add(w.appId);
    if (w.scope === "all") for (const a of appIds) out.add(a);
  }
  for (const m of monitors) {
    for (const w of live) {
      if (!covers(w, { monitorId: m.id, appId: m.appId })) continue;
      out.add(m.id);
      if (w.scope !== "monitor") out.add(m.appId);
    }
  }
  return out;
}

// Review M4: a one-off window whose end has already passed would change nothing (old checks are never re-marked).
export function hasEnded(w: Pick<Window, "startsAt" | "durationMin" | "weekly">, now: Date): boolean {
  return !w.weekly && w.startsAt.getTime() + w.durationMin * 60_000 <= now.getTime();
}
export const ENDED = "That window has already ended.";

export type WindowForm = { scope?: unknown; targetId?: unknown; start?: unknown; durationMin?: unknown; weekly?: unknown; note?: unknown };

// The dialog's fields. `start` is a datetime-local value ("2026-10-13T22:00"), read in the configured zone.
export function parseWindowForm(f: WindowForm): { ok: true; value: Omit<Window, "id"> } | { ok: false; fieldErrors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const scope = f.scope === "all" || f.scope === "app" || f.scope === "monitor" ? f.scope : null;
  if (!scope) errors.scope = "Pick what it applies to.";
  const raw = typeof f.start === "string" ? f.start : "";
  // A date that doesn't exist (31 Feb) is refused, not rolled over.
  const startsAt = fromLocalInput(raw);
  if (!startsAt) errors.start = "Pick a start time.";
  const durationMin = Number(f.durationMin);
  if (!(DURATIONS_MIN as readonly number[]).includes(durationMin)) errors.durationMin = "Pick how long it lasts.";
  const target = typeof f.targetId === "string" ? f.targetId : "";
  if (scope && scope !== "all" && !isUuid(target)) errors.targetId = scope === "app" ? "Pick an application." : "Pick a monitor.";
  if (Object.keys(errors).length || !scope || !startsAt) return { ok: false, fieldErrors: errors };
  const note = (typeof f.note === "string" ? f.note : "").trim().slice(0, NOTE_MAX) || null;
  return { ok: true, value: { scope, appId: scope === "app" ? target : null, monitorId: scope === "monitor" ? target : null, startsAt, durationMin, weekly: f.weekly === true, note } };
}

// The dialog's Lasts options: "30 min", "1 h", "1 h 30 min", "3 h", "6 h".
export function durationText(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return [h ? `${h} h` : "", m ? `${m} min` : ""].filter(Boolean).join(" ");
}

// The dialog's Applies to is one select: "all", "app:<id>" or "monitor:<id>".
export function targetValue(w: Pick<Window, "scope" | "appId" | "monitorId">): string {
  return w.scope === "all" ? "all" : w.scope === "app" ? `app:${w.appId}` : `monitor:${w.monitorId}`;
}

export function splitTarget(v: string): { scope: string; targetId: string } {
  if (v === "all") return { scope: "all", targetId: "" };
  const m = /^(app|monitor):(.+)$/.exec(v);
  return m ? { scope: m[1], targetId: m[2] } : { scope: "", targetId: "" };
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Uptime → Maintenance windows: "Every Sunday 01:00–02:00" / "13 Oct 22:00–23:30", and Active / Next / Over.
export function windowText(w: Window, now: Date): { when: string; status: { state: State; text: string } } {
  const end = new Date(w.startsAt.getTime() + w.durationMin * 60_000);
  const when = w.weekly ? `Every ${DAYS[zonedParts(w.startsAt).weekday]} ${clock(w.startsAt)}–${clock(end)}` : `${dayMonth(w.startsAt)} ${clock(w.startsAt)}–${clock(end)}`;
  const cur = occurrence(w, now);
  if (cur) return { when, status: { state: "maint", text: `Active · until ${clock(cur.end)}` } };
  const next = nextOccurrence(w, now);
  return { when, status: next ? { state: "off", text: `Next: ${dayMonth(next.start)} ${clock(next.start)}` } : { state: "off", text: "Over" } };
}
