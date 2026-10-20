// The one place that knows the time zone (1.1, D1-D5). Clock times, calendar days, the daily job, the digest and
// maintenance windows all follow WATCHBELL_TIMEZONE (an IANA name such as Europe/Berlin; the old WATCHPOST_TIMEZONE
// is read too), whatever the server's own zone is. Unset means Asia/Jakarta (WIB), so an install from before 1.1 and
// the hosted console keep exactly the times and texts they had. An unknown name falls back to Asia/Jakarta with one
// warning. Offsets come from Intl for each instant, so daylight saving and half-hour zones just work: there is no
// fixed offset anywhere.
import { readEnvNamed } from "@/lib/brand-env";
import { mode } from "@/lib/mode";

export const DEFAULT_TIME_ZONE = "Asia/Jakarta";

const DAY = 86_400_000;

// ---------------------------------------------------------------------------------------------------- the zone

let resolved: string | null = null; // the server's zone, read once per process (module instance)
let rejected: string | null = null; // the setting that was refused, as "WATCHBELL_TIMEZONE=Asia/Jakata"
let testZone: string | undefined; // resetTimeZoneForTests(zone)
let browserZone: string | null = null; // what the server told the browser (setBrowserTimeZone)

type Warned = { __watchbellZoneWarned?: boolean };

// A full IANA name, Area/Location ("Europe/Berlin", "America/Argentina/Buenos_Aires", "Etc/GMT-7"), or UTC/GMT.
// Nothing else, though Intl accepts more: Postgres (the uptime days, metrics-db.ts) would read it another way.
// - An offset: "+07:00" is a POSIX zone to Postgres (UTC-7, the opposite sign), "+0530" is refused.
// - An abbreviation: Intl maps IST to India, BST to Dhaka, CET to Brussels (with DST); Postgres reads IST as Israel, BST
//   as British Summer Time, CET as a fixed UTC+1, and refuses AET or ECT. Same for POSIX names such as EST5EDT.
// The CLI (bin/watchbell.mjs machineTimeZone) and both installers use the same rule.
const ZONE_NAME = /^(?:UTC|GMT|[A-Za-z]+(?:\/[A-Za-z0-9_+\-]+)+)$/i;

// Older names Intl (ICU) still prefers to the current ones; shown and stored by their current name. The CLI
// (bin/watchbell.mjs) and both installers (install.sh, install.ps1) keep a copy; time.test.ts checks they match.
export const LEGACY_ZONES: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata", "Asia/Katmandu": "Asia/Kathmandu", "Asia/Saigon": "Asia/Ho_Chi_Minh", "Asia/Rangoon": "Asia/Yangon",
};

// The zone as Intl knows it, or null. A name that differs from the canonical one only in case is written the canonical
// way ("europe/berlin", "asia/kolkata" → "Asia/Kolkata"); otherwise the operator's spelling is kept.
function checkZone(raw: string): string | null {
  if (!ZONE_NAME.test(raw)) return null;
  try {
    const canonical = new Intl.DateTimeFormat("en-US", { timeZone: raw }).resolvedOptions().timeZone;
    const current = LEGACY_ZONES[canonical] ?? canonical;
    if (current.toLowerCase() === raw.toLowerCase()) return current;
    return canonical.toLowerCase() === raw.toLowerCase() ? canonical : raw;
  } catch {
    return null;
  }
}

function resolveServerZone(): string {
  rejected = null;
  const named = testZone !== undefined ? { name: "WATCHBELL_TIMEZONE", value: testZone } : readEnvNamed(typeof process === "undefined" ? {} : process.env, "TIMEZONE");
  const raw = named?.value.trim() ?? "";
  if (raw === "") return DEFAULT_TIME_ZONE;
  const zone = checkZone(raw);
  if (zone) return zone;
  rejected = `${named!.name}=${raw}`;
  // One line per process, even when several bundles (server, SSR, route handlers) each load this module.
  const g = globalThis as Warned;
  if (!g.__watchbellZoneWarned) {
    g.__watchbellZoneWarned = true;
    console.warn(`Watchbell: ${rejected} is not a time zone (use an IANA name such as Europe/Berlin). Using ${DEFAULT_TIME_ZONE} (WIB).`);
  }
  return DEFAULT_TIME_ZONE;
}

/** Server: the refused setting ("WATCHBELL_TIMEZONE=Asia/Jakata") when the fallback is in use, else null. */
export function zoneProblem(): string | null {
  timeZone();
  return typeof window === "undefined" ? rejected : null;
}

/** The IANA zone every time is shown and scheduled in. */
export function timeZone(): string {
  // In the browser there is no WATCHBELL_TIMEZONE: the console layout hands the server's zone over (TimeZoneSync).
  if (typeof window !== "undefined") return browserZone ?? DEFAULT_TIME_ZONE;
  return (resolved ??= resolveServerZone());
}

/** Browser only: the zone the server resolved, so client components render what the server rendered. */
export function setBrowserTimeZone(zone: string): void {
  if (typeof window === "undefined") return;
  browserZone = checkZone(zone) ?? DEFAULT_TIME_ZONE;
}

/** Tests: forget the resolved zone; with `zone`, resolve as if WATCHBELL_TIMEZONE were set to it. */
export function resetTimeZoneForTests(zone?: string): void {
  resolved = null;
  testZone = zone;
  (globalThis as Warned).__watchbellZoneWarned = false;
}

/** The label after a time: "WIB" for Asia/Jakarta (as before 1.1), else Intl's short name ("CET", "EDT", "GMT+5:30"). */
export function zoneLabel(at: Date = new Date()): string {
  const zone = timeZone();
  if (zone === DEFAULT_TIME_ZONE) return "WIB";
  // The name depends only on the zone and its offset at that instant: remembered per pair (it is asked per row).
  const key = `${zone}|${offsetAt(at.getTime(), zone)}`;
  let label = labels.get(key);
  if (label === undefined) {
    const name = (locale: string) =>
      zonedFormat(locale, { timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
    // en-US names America's zones (EST) but writes Europe's as GMT+1; en-GB has CET/CEST/BST. Prefer a real abbreviation.
    const us = name("en-US");
    const gb = /^GMT[+-]/.test(us) ? name("en-GB") : "";
    label = !/^GMT[+-]/.test(us) || /^GMT[+-]/.test(gb) || gb === "" ? us : gb;
    labels.set(key, label);
  }
  return label;
}
const labels = new Map<string, string>();

const formats = new Map<string, Intl.DateTimeFormat>();
/** An Intl formatter in the configured zone, built once per zone, locale and options (building one costs ~40 µs). */
export function zonedFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const zone = timeZone();
  const key = `${zone}|${locale}|${JSON.stringify(options)}`;
  let f = formats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone });
    formats.set(key, f);
  }
  return f;
}

// The hosted (cloud) edition's daily job is Vercel Cron at 20:00 UTC whatever the zone (1.1, D6); its local time.
function cronTime(now: Date): string {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 20));
  return `${clock(at)} ${zoneLabel(at)}`;
}

/** When the daily job runs, for texts: "03:00 WIB"; "03:00 Europe/Berlin" (self-host's own clock); in cloud the local
 * time of Vercel Cron's 20:00 UTC ("03:00 WIB", "21:00 CET"). */
export function dailyRunText(now: Date = new Date()): string {
  let cloud = false;
  try {
    cloud = mode() === "cloud";
  } catch {
    // A bad WATCHBELL_MODE stops the server elsewhere; the text needn't.
  }
  return cloud ? cronTime(now) : `03:00 ${zoneName()}`;
}

/** Vercel Cron's daily run (20:00 UTC) in the configured zone, for the API docs: "03:00 WIB", "21:00 CET". */
export const vercelCronText = (now: Date = new Date()): string => cronTime(now);

/** For text about times in general ("Times in WIB", "07:00 Europe/Berlin"): "WIB" for Asia/Jakarta, else the zone's name. */
export function zoneName(): string {
  const zone = timeZone();
  return zone === DEFAULT_TIME_ZONE ? "WIB" : zone;
}

/** The note under a list of times: "Times are WIB." for Asia/Jakarta, else "Times are Europe/Berlin time." */
export function zoneSentence(): string {
  const name = zoneName();
  return name === "WIB" ? "Times are WIB." : `Times are ${name} time.`;
}

// ---------------------------------------------------------------------------------------------------- wall-clock maths

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(zone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    partsFormatters.set(zone, f);
  }
  return f;
}

/** The wall-clock date and time of `d` in the zone (month 1-12, weekday 0 = Sunday). */
export function zonedParts(d: Date, zone: string = timeZone()): ZonedParts {
  const parts = partsFormatter(zone).formatToParts(d);
  const n = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value);
  const year = n("year");
  const month = n("month");
  const day = n("day");
  return { year, month, day, hour: n("hour"), minute: n("minute"), second: n("second"), weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

// The zone's offset at instant t, in ms (local wall time read as UTC, minus t).
function offsetAt(t: number, zone: string): number {
  const p = zonedParts(new Date(t), zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

/** The configured zone's offset from UTC at `at`, in minutes (420 for WIB, 330 for Asia/Kolkata, 60 or 120 for Berlin). */
export function utcOffsetMinutes(at: Date = new Date()): number {
  return Math.round(offsetAt(at.getTime(), timeZone()) / 60_000);
}

// The instant a wall-clock time happens. Day and month overflow roll over like Date.UTC. A time that happens twice
// (clocks go back) is the first one; a time that doesn't exist (clocks go forward) is moved forward by the gap, so
// 02:30 on the spring-forward night is 03:30.
function fromWall(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, zone: string): Date {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const before = offsetAt(wall - DAY, zone);
  const after = offsetAt(wall + DAY, zone);
  const fits = [...new Set([before, after])].map((o) => wall - o).filter((t) => offsetAt(t, zone) === wall - t);
  return new Date(fits.length ? Math.min(...fits) : wall - before);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** The calendar day of `d` in the zone, "YYYY-MM-DD". */
export function dayKey(d: Date): string {
  const p = zonedParts(d);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** Local midnight of a "YYYY-MM-DD" day (a day can be 23 or 25 hours long). */
export function dayStart(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return fromWall(y, m, d, 0, 0, 0, 0, timeZone());
}

/** The same wall time n calendar days later (or earlier): 10:00 stays 10:00 across a daylight-saving change. */
export function addLocalDays(d: Date, n: number): Date {
  const zone = timeZone();
  const plain = d.getTime() + n * DAY;
  // No change of offset in between: exactly n × 24 h. (For a start in a repeated hour this keeps the same of the two
  // occurrences; the slow path below, like fromLocalInput, takes the first. Both read the same on the clock.)
  if (offsetAt(plain, zone) === offsetAt(d.getTime(), zone)) return new Date(plain);
  const p = zonedParts(d, zone);
  return fromWall(p.year, p.month, p.day + n, p.hour, p.minute, p.second, d.getTime() - Math.floor(d.getTime() / 1000) * 1000, zone);
}

/**
 * Whether a once-a-day job last done on `lastDay` ("YYYY-MM-DD", null = never) may run again on the local day of `now`
 * (the daily job, the digest). A later day only, not just another one: after a change to a zone behind the old one the
 * stored day can be tomorrow, and the job must not run twice. A stored day more than one day ahead can't come from a
 * change of zone, only from a clock that was once wrong (a restored VM, a bad NTP or RTC jump): it is not trusted, so
 * the job doesn't stop until that date. Neither is anything that isn't a date.
 */
export function newDaySince(now: Date, lastDay: string | null): boolean {
  if (lastDay === null || !/^\d{4}-\d{2}-\d{2}$/.test(lastDay)) return true;
  return dayKey(now) > lastDay || lastDay > dayKey(addLocalDays(now, 1));
}

/** A datetime-local value ("2026-10-13T22:00") read in the zone; null when it is malformed or not a real date (31 Feb). */
export function fromLocalInput(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const check = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || check.getUTCHours() !== h || check.getUTCMinutes() !== mi) return null;
  return fromWall(y, mo, d, h, mi, 0, 0, timeZone());
}

/** The datetime-local value of an instant in the zone ("2026-10-13T22:00"). */
export function toLocalInput(d: Date): string {
  const p = zonedParts(d);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

// ---------------------------------------------------------------------------------------------------- text

/** "HH:MM" in the zone. */
export function clock(d: Date): string {
  const p = zonedParts(d);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "HH:MM:SS" in the zone. */
export function clockSeconds(d: Date): string {
  const p = zonedParts(d);
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

// Fixed names: Intl's en-GB abbreviation for September is "Sept", the console writes "Sep".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The calendar date in the zone. */
export function calendarDate(d: Date): { day: number; month: string; year: number } {
  const p = zonedParts(d);
  return { day: p.day, month: MONTHS[p.month - 1], year: p.year };
}

export function dayMonth(d: Date): string {
  const { day, month } = calendarDate(d);
  return `${day} ${month}`;
}

export function sameDay(a: Date, b: Date): boolean {
  return dayKey(a) === dayKey(b);
}

// "12s ago", "3 min ago", then the clock time ("today 09:00", "2 Oct 03:30"). A date in the future reads as 0s.
export function ago(d: Date, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return sameDay(d, now) ? `today ${clock(d)}` : `${dayMonth(d)} ${clock(d)}`;
}

export function lastSync(d: Date | null, now: Date): string {
  if (!d) return "never";
  const min = Math.round((now.getTime() - d.getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return sameDay(d, now) ? `today ${clock(d)}` : `${dayMonth(d)} ${clock(d)}`;
}

export function expires(d: Date | null, now: Date): string {
  if (!d) return "—";
  const diff = d.getTime() - now.getTime();
  if (diff >= 0) {
    const n = Math.floor(diff / DAY);
    return n === 0 ? "today" : `in ${n} day${n === 1 ? "" : "s"}`;
  }
  const n = Math.max(1, Math.floor(-diff / DAY));
  return `expired ${n} day${n === 1 ? "" : "s"} ago`;
}
