// Short time texts the AI pages share (moved out of antigravity.ts in open source plan 5, so the pages that ship in both
// editions don't import Antigravity). Pure; no "server-only", client code may import it.

// "HH:MM WIB" (with the date when it isn't today in Jakarta).
export function wibTime(d: Date, now: Date): string {
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", ...o }).format(d);
  const day = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(x);
  const time = f({ hour: "2-digit", minute: "2-digit", hour12: false });
  return day(d) === day(now) ? `${time} WIB` : `${f({ day: "numeric", month: "short" })} ${time} WIB`;
}

export function agoShort(d: Date, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}
