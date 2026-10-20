import { clock, dayMonth, sameDay, wibDate } from "@/lib/time";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// R6: "now", "N min ago", "N h ago", "N d ago". A time in the future reads as "now".
export function rel(d: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - d.getTime());
  if (ms < MIN) return "now";
  if (ms < HOUR) return `${Math.floor(ms / MIN)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  return `${Math.floor(ms / DAY)} d ago`;
}

// Deployments → Created: relative for the last hour, the WIB clock for the rest of today, then "N d ago".
export function createdText(d: Date, now: Date): string {
  const ms = now.getTime() - d.getTime();
  if (ms < HOUR) return rel(d, now);
  if (sameDay(d, now)) return clock(d);
  return `${Math.max(1, Math.floor(ms / DAY))} d ago`;
}

// "41s", "1m 12s", "1m 08s", "1h 02m".
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export type DeployTimes = { state: string; createdAt: Date; buildingAt: Date | null; readyAt: Date | null };

// Deployments → Duration: elapsed while building, the build time once finished, "—" when Vercel gave no times.
export function deployDuration(d: DeployTimes, now: Date): string {
  if (d.state === "building") return `${duration(now.getTime() - (d.buildingAt ?? d.createdAt).getTime())} elapsed`;
  if (d.readyAt && d.buildingAt) return duration(d.readyAt.getTime() - d.buildingAt.getTime());
  return "—";
}

// Applications → Last deploy: "2 h ago", "building 38s", "failed 19:41" (today) or "failed 3 d ago".
export function lastDeployText(d: DeployTimes | null, now: Date): string {
  if (!d) return "—";
  if (d.state === "building") return `building ${duration(now.getTime() - (d.buildingAt ?? d.createdAt).getTime())}`;
  const at = d.readyAt ?? d.createdAt;
  if (d.state === "error") return `failed ${sameDay(at, now) ? clock(at) : rel(at, now)}`;
  if (d.state === "canceled") return `canceled ${rel(at, now)}`;
  return rel(at, now);
}

// Floors to 2 decimals so that only a true 100 reads "100.00%" (99.996 is "99.99%"); the epsilon absorbs float noise.
export const pct = (n: number | null): string => (n === null ? "—" : `${(Math.floor(n * 100 + 1e-6) / 100).toFixed(2)}%`);
export const msText = (n: number | null): string => (n === null ? "—" : `${Math.round(n)} ms`);
export const itemCount = (n: number): string => `${n} item${n === 1 ? "" : "s"}`;

// Events and Activity: the WIB clock for today, with the day in front for anything older.
export function eventTime(d: Date, now: Date): string {
  return sameDay(d, now) ? clock(d) : `${dayMonth(d)} ${clock(d)}`;
}

// Banners: "4 minutes", "2 hours", "1 day".
export function forHowLong(since: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - since.getTime());
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (ms < HOUR) return unit(Math.max(1, Math.floor(ms / MIN)), "minute");
  if (ms < DAY) return unit(Math.floor(ms / HOUR), "hour");
  return unit(Math.floor(ms / DAY), "day");
}

export const shortSha = (sha: string | null): string => (sha ? sha.slice(0, 7) : "—");

// A commit message as the tables show it: its subject only (J). The body, "Co-Authored-By:" trailers included, stays
// out. The first line that has text, trimmed; "" when there is none.
export function commitTitle(message: string | null | undefined): string {
  if (!message) return "";
  return message.split(/\r?\n|\r/).map((l) => l.trim()).find((l) => l !== "") ?? "";
}

export function hostPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

// App detail → Created: "14 Mar 2026".
export function longDate(d: Date): string {
  const { day, month, year } = wibDate(d);
  return `${day} ${month} ${year}`;
}

// The domain an app is checked at: the host of its oldest monitor (Sync creates that one at the production domain).
// Only a web URL names a domain: a heartbeat's url ("heartbeat:backup-job", U3) parses as a URL with an empty host.
export function appDomain(name: string, urls: string[]): string {
  for (const u of urls) {
    try {
      const url = new URL(u);
      if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.host) continue;
      return url.host;
    } catch {
      // not a URL: try the next monitor
    }
  }
  return `${name}.vercel.app`;
}
