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

// How far the zone's wall clock is ahead of UTC at an instant, in ms.
function zoneOffset(at: number, zone: string): number {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at));
  const v = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second")) - at;
}

// The instant a "YYYY-MM-DD" day starts in a time zone. Review M-12 (1.7.1): the offset is taken again at the first
// answer, so a day whose midnight has another offset than its UTC midnight (a DST change in between) is still right.
export function zoneMidnight(day: string, zone: string): Date {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const first = guess - zoneOffset(guess, zone);
  return new Date(guess - zoneOffset(first, zone));
}
