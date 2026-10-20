import { CERT_WARN_DAYS, daysLeft, DOMAIN_WARN_DAYS, isoDate, pointsToVercel, vercelProxied, type DnsRecord, type RdapFact, type TlsFact, type VercelFact } from "@/lib/network/rules";
import type { State } from "@/lib/status";
import { ago } from "@/lib/time";
import { longDate } from "./format";
import { worst } from "./labels";

// How the Domains and DNS records pages read the network facts (mockup: pages domains and dns).
export type Cell = { text: string; sub: string | null; state: State | null };
const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

export function expiryCell(rdap: RdapFact | null, zoneName: string | null, isVercel: boolean, now: Date): Cell {
  if (isVercel) return { text: "Vercel's domain", sub: null, state: null };
  if (!zoneName) return { text: "Unknown", sub: "Not in a watched Cloudflare zone", state: "unknown" };
  if (!rdap) return { text: "Unknown", sub: "Not read yet", state: "unknown" };
  const at = isoDate(rdap.expiresAt);
  if (!at) return { text: "Unknown", sub: rdap.error ?? "The registry didn't say", state: "unknown" };
  const n = daysLeft(at, now)!;
  if (n < 0) return { text: longDate(at), sub: `expired ${days(-n)} ago`, state: "err" };
  return { text: longDate(at), sub: `in ${days(n)}`, state: n < DOMAIN_WARN_DAYS ? "warn" : null };
}

export function certCell(tls: TlsFact | null, isVercel: boolean, now: Date): Cell {
  if (isVercel) return { text: "Managed by Vercel", sub: null, state: null };
  if (!tls) return { text: "Not checked yet", sub: "The first check runs within a day", state: "unknown" };
  const checked = isoDate(tls.checkedAt);
  if (tls.error) return { text: "Check failed", sub: tls.error, state: "warn" };
  const at = isoDate(tls.notAfter);
  const n = daysLeft(at, now);
  if (n === null) return { text: "Unknown", sub: null, state: "unknown" };
  const sub = [tls.issuer, checked ? `checked ${ago(checked, now)}` : null].filter(Boolean).join(" · ") || null;
  if (n < 0) return { text: `Expired ${days(-n)} ago`, sub, state: "err" };
  if (tls.authorized === false) return { text: `${days(n)} left`, sub: "Not trusted by browsers", state: "err" };
  return { text: `${days(n)} left`, sub, state: n < CERT_WARN_DAYS ? "warn" : "ok" };
}

const ADDRESS = ["A", "AAAA", "CNAME"];
export function dnsCell(records: DnsRecord[], isVercel: boolean, zoneName: string | null, extraIps: string[]): { text: string; proxiedToVercel: boolean } {
  if (isVercel) return { text: "Managed by Vercel", proxiedToVercel: false };
  if (!zoneName) return { text: "Not in a watched Cloudflare zone", proxiedToVercel: false };
  const addr = records.filter((r) => ADDRESS.includes(r.type));
  if (!addr.length) return { text: "No address record in the zone", proxiedToVercel: false };
  const main = addr.find((r) => pointsToVercel(r, extraIps)) ?? addr[0];
  return { text: `${main.type} → ${main.content}${addr.length > 1 ? ` (+${addr.length - 1})` : ""}`, proxiedToVercel: vercelProxied(records, extraIps).length > 0 };
}

export function vercelCell(v: VercelFact | null, isVercel: boolean): { state: State; label: string } {
  if (!v) return isVercel ? { state: "ok", label: "Valid" } : { state: "unknown", label: "Not read yet" };
  return v.misconfigured ? { state: "warn", label: "Misconfigured" } : { state: "ok", label: "Valid" };
}

export const ttlText = (ttl: number): string =>
  ttl === 1 ? "Auto" : ttl % 3600 === 0 ? `${ttl / 3600} h` : ttl % 60 === 0 ? `${ttl / 60} min` : `${ttl} s`;

export function proxiedBannerText(certDays: number | null): string {
  const base = "Vercel recommends DNS only (grey cloud) for records that point to Vercel. Proxying can stop certificate renewal";
  return certDays === null || certDays < 0 ? `${base}.` : `${base}, and this certificate expires in ${days(certDays)}.`;
}

export function zoneStatusLabel(status: string | null, paused: boolean): { state: State; label: string } {
  if (!status) return { state: "unknown", label: "Not read yet" };
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  if (status === "moved") return { state: "err", label };
  if (status !== "active") return { state: "warn", label };
  return paused ? { state: "warn", label: `${label} · paused` } : { state: "ok", label };
}

// Overview → status strip, Cloudflare cell (mockup: "1 cert expires in 12 days"): the domains that sit in a watched
// Cloudflare zone, their worst state and how many need attention. Unknown is never shown as ok.
export function cloudflareCell(domains: { state: State; zoneName: string | null }[]): { state: State; sub: string } {
  const zoned = domains.filter((d) => d.zoneName);
  if (!zoned.length) return { state: "unknown", sub: "No domains in a watched zone yet" };
  const attention = zoned.filter((d) => d.state === "warn" || d.state === "err" || d.state === "fail").length;
  const unread = zoned.filter((d) => d.state === "unknown").length;
  const parts = [`${zoned.length} domain${zoned.length === 1 ? "" : "s"}`, attention ? `${attention} need${attention === 1 ? "s" : ""} attention` : null, unread ? `${unread} not read yet` : null];
  return { state: worst(zoned.map((d) => d.state)), sub: parts.filter(Boolean).join(" · ") };
}
