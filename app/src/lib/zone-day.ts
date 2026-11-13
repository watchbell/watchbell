// "YYYY-MM-DD" of an instant in a time zone (the install's zone for reports and the daily deploy summary).
export function zoneDay(at: Date, zone: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${v("year")}-${v("month")}-${v("day")}`;
}

// The days of a "YYYY-MM" month, as "YYYY-MM-DD".
export function monthDays(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

// The instant a "YYYY-MM-DD" day starts in a time zone.
export function zoneMidnight(day: string, zone: string): Date {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(guess));
  const v = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const local = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second"));
  return new Date(guess - (local - guess));
}
