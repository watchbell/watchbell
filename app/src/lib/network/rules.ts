import type { NewEvent } from "@/lib/collector/rules";
import type { State } from "@/lib/status";

// Pure network rules (stage 4): which zone a host sits in, which records point to Vercel, and the zone and domain
// states the Domains, DNS records and Topology pages show. Stage 5's alert rules read the same facts.

export type DnsRecord = { id: string; type: string; name: string; content: string; proxied: boolean; ttl: number; comment: string | null };
export type TlsFact = { notAfter: string | null; issuer: string | null; authorized: boolean | null; error: string | null; checkedAt: string };
export type VercelFact = { misconfigured: boolean; configuredBy: string | null; recommendedIps: string[]; checkedAt: string };
export type RdapFact = { expiresAt: string | null; registrar: string | null; error: string | null; checkedAt: string };
export type CertPack = { type: string; status: string; hosts: string[]; expiresOn: string | null };

export const CERT_WARN_DAYS = 14; // CertExpiringSoon (spec §10)
export const DOMAIN_WARN_DAYS = 30; // DomainExpiringSoon (spec §10)
export const ITEM_REFRESH_MS = 20 * 3_600_000;
export const MAX_ITEMS_PER_RUN = 10;
const DAY = 86_400_000;

export function isoDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function daysLeft(at: Date | null, now: Date): number | null {
  return at ? Math.floor((at.getTime() - now.getTime()) / DAY) : null;
}

export function dueForRefresh(checkedAt: unknown, now: Date): boolean {
  const d = isoDate(checkedAt);
  return !d || now.getTime() - d.getTime() >= ITEM_REFRESH_MS;
}

const bare = (h: string) => h.toLowerCase().replace(/\.$/, "");
export const isVercelHost = (host: string) => bare(host).endsWith(".vercel.app");

export function zoneFor(host: string, zones: string[]): string | null {
  const h = bare(host);
  const hits = zones.map(bare).filter((z) => h === z || h.endsWith(`.${z}`));
  return hits.sort((a, b) => b.length - a.length)[0] ?? null;
}

export function recordsFor(host: string, records: DnsRecord[]): DnsRecord[] {
  const h = bare(host);
  return records.filter((r) => bare(r.name) === h);
}

// Vercel's documented apex address plus whatever Vercel's own domain config recommends (VercelFact.recommendedIps).
const VERCEL_IPV4 = ["76.76.21.21"];
const VERCEL_CNAME = /(^|\.)vercel-dns(-\d+)?\.com$/;

export function pointsToVercel(r: Pick<DnsRecord, "type" | "content">, extraIps: string[] = []): boolean {
  if (r.type === "CNAME") return VERCEL_CNAME.test(bare(r.content));
  if (r.type === "A") return [...VERCEL_IPV4, ...extraIps].includes(r.content.trim());
  return false;
}

export function vercelProxied(records: DnsRecord[], extraIps: string[] = []): DnsRecord[] {
  return records.filter((r) => r.proxied && pointsToVercel(r, extraIps));
}

const SSL_LABEL: Record<string, string> = { off: "Off", flexible: "Flexible", full: "Full", strict: "Full (strict)", origin_pull: "Strict (origin pull)" };
export function sslModeLabel(v: string | null): string | null {
  return v === null ? null : SSL_LABEL[v] ?? v;
}

const PACK_BAD = new Set(["expired", "deleted", "inactive", "deactivating", "initializing_timed_out", "validation_timed_out", "issuance_timed_out", "deployment_timed_out", "deletion_timed_out"]);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

export function edgeCertSummary(packs: CertPack[]): { state: State; label: string; expiresOn: string | null } {
  const pack = packs.find((p) => p.type === "universal") ?? packs.find((p) => p.status === "active") ?? packs[0];
  if (!pack) return { state: "unknown", label: "No edge certificate found", expiresOn: null };
  const state: State = pack.status === "active" ? "ok" : PACK_BAD.has(pack.status) ? "err" : "warn";
  return { state, label: `${cap(pack.type)} · ${pack.status.replace(/_/g, " ")}`, expiresOn: pack.expiresOn };
}

const worst = (list: State[]): State => (list.includes("err") ? "err" : list.includes("warn") ? "warn" : "ok");
const daysText = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

function expiryReason(what: "Domain" | "Certificate", at: Date | null, warnDays: number, now: Date): { state: State; reason: string } | null {
  const n = daysLeft(at, now);
  if (n === null) return null;
  if (n < 0) return { state: "err", reason: `${what} expired ${daysText(-n)} ago` };
  if (n < warnDays) return { state: "warn", reason: `${what} expires in ${daysText(n)}` };
  return null;
}

export function zoneState(z: { status: string | null; paused: boolean; rdap: RdapFact | null }, now: Date): { state: State; reasons: string[] } {
  if (!z.status) return { state: "unknown", reasons: [] };
  const found: { state: State; reason: string }[] = [];
  if (z.status === "moved") found.push({ state: "err", reason: "The zone moved away from Cloudflare" });
  else if (z.status !== "active") found.push({ state: "warn", reason: `Zone is ${z.status}` });
  if (z.paused) found.push({ state: "warn", reason: "Cloudflare is paused for this zone" });
  const exp = expiryReason("Domain", isoDate(z.rdap?.expiresAt), DOMAIN_WARN_DAYS, now);
  if (exp) found.push(exp);
  return { state: worst(found.map((f) => f.state)), reasons: found.map((f) => f.reason) };
}

export function domainState(
  d: { host: string; tls: TlsFact | null; vercel: VercelFact | null; records: DnsRecord[]; zoneRdap: RdapFact | null },
  now: Date,
): { state: State; reasons: string[] } {
  const found: { state: State; reason: string }[] = [];
  if (d.vercel?.misconfigured) found.push({ state: "warn", reason: "Vercel says the DNS is misconfigured" });
  if (isVercelHost(d.host)) return { state: worst(found.map((f) => f.state)), reasons: found.map((f) => f.reason) };
  if (!d.tls && !d.vercel && !d.records.length) return { state: "unknown", reasons: [] };
  if (d.tls?.error) found.push({ state: "warn", reason: `TLS check failed: ${d.tls.error}` });
  else if (d.tls) {
    const exp = expiryReason("Certificate", isoDate(d.tls.notAfter), CERT_WARN_DAYS, now);
    if (exp) found.push(exp);
    else if (d.tls.authorized === false) found.push({ state: "err", reason: "Certificate isn't trusted" });
  }
  if (vercelProxied(d.records, d.vercel?.recommendedIps ?? []).length) found.push({ state: "warn", reason: "Proxied by Cloudflare in front of Vercel" });
  const dom = expiryReason("Domain", isoDate(d.zoneRdap?.expiresAt), DOMAIN_WARN_DAYS, now);
  if (dom) found.push(dom);
  return { state: worst(found.map((f) => f.state)), reasons: found.map((f) => f.reason) };
}

// Like monitor events: nothing on the first reading (prev null or unknown), one event per change after that.
export function networkEvent(input: { resourceId: string; name: string; prev: State | null; next: State; reasons: string[]; at: Date }): NewEvent | null {
  const { prev, next } = input;
  if (prev === null || prev === "unknown" || prev === next || next === "unknown") return null;
  const base = { resourceId: input.resourceId, type: "system" as const, at: input.at };
  if (next === "ok") return { ...base, reason: "NetworkRecovered", kind: "ok", message: `${input.name} is fine again`, detail: null };
  return { ...base, reason: "NetworkAttention", kind: next, message: `${input.name} needs attention`, detail: input.reasons.join(" · ") || null };
}
