// Clock times in the console are shown in WIB, whatever the server's time zone is.
export const TZ = "Asia/Jakarta";

const DAY = 86_400_000;

export function clock(d: Date): string {
  return d.toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
}

// Fixed names: Intl's en-GB abbreviation for September is "Sept", the console writes "Sep".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The calendar date in WIB.
export function wibDate(d: Date): { day: number; month: string; year: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "numeric", year: "numeric" }).formatToParts(d);
  const num = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { day: num("day"), month: MONTHS[num("month") - 1], year: num("year") };
}

export function dayMonth(d: Date): string {
  const { day, month } = wibDate(d);
  return `${day} ${month}`;
}

export function sameDay(a: Date, b: Date): boolean {
  return a.toLocaleDateString("en-CA", { timeZone: TZ }) === b.toLocaleDateString("en-CA", { timeZone: TZ });
}

// "12s ago", "3 min ago", then the WIB clock time ("today 09:00", "2 Oct 03:30"). A date in the future reads as 0s.
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
