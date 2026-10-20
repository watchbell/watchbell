import { ttlText } from "@/lib/view/network";
import type { DnsRecord } from "./rules";

// Stage 6 slice 2 (plan B3/B4/B6): what the console may change on a Cloudflare DNS record, and how a change reads. Pure,
// so the edit dialog and the server action validate the same way. Only A, AAAA, CNAME and TXT records are edited; their
// type and name never change, and the console never creates or deletes a record.

export const EDITABLE = ["A", "AAAA", "CNAME", "TXT"] as const;
export const PROXIABLE = ["A", "AAAA", "CNAME"] as const;
export const AUTO_TTL = 1;
export const TTL_MIN = 60;
export const TTL_MAX = 86_400;
// The TTL picker's choices (Cloudflare's own list, Auto first).
export const TTL_CHOICES = [1, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18_000, 43_200, 86_400] as const;
export const TXT_MAX = 2048;

export type RecordValues = { content: string; ttl: number; proxied: boolean };
export type EditField = "content" | "ttl" | "proxied";
export type Change = { field: EditField; before: string; after: string };

export const canEdit = (type: string): boolean => (EDITABLE as readonly string[]).includes(type);
export const canProxy = (type: string): boolean => (PROXIABLE as readonly string[]).includes(type);

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const LABEL = "[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?";
const HOST = new RegExp(`^(?=.{1,253}$)(?:${LABEL}\\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`);
const PRINTABLE = /^[\x20-\x7e]+$/;
const bare = (h: string) => h.trim().toLowerCase().replace(/\.$/, "");

// IPv6 without a zone index: the URL parser accepts exactly the valid forms, in the browser and in Node alike.
function isIpv6(v: string): boolean {
  if (!v.includes(":") || !/^[0-9a-f:.]+$/i.test(v)) return false;
  try {
    return new URL(`http://[${v}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

// The content as Cloudflare compares it: hostnames without case or a trailing dot, addresses in lower case.
export function normalContent(type: string, content: string): string {
  const c = content.trim();
  if (type === "CNAME") return bare(c);
  if (type === "AAAA") return c.toLowerCase();
  return c;
}

type Valid = { ok: true; values: RecordValues } | { ok: false; field: EditField; error: string };

export function validateEdit(r: { type: string; name: string }, next: RecordValues): Valid {
  if (!canEdit(r.type)) return { ok: false, field: "content", error: "Only A, AAAA, CNAME and TXT records can be edited here." };
  const content = normalContent(r.type, String(next.content ?? ""));
  if (r.type === "A" && !IPV4.test(content)) return { ok: false, field: "content", error: "An A record needs an IPv4 address, like 76.76.21.21." };
  if (r.type === "AAAA" && !isIpv6(content)) return { ok: false, field: "content", error: "An AAAA record needs an IPv6 address, like 2606:4700::1111." };
  if (r.type === "CNAME") {
    if (!HOST.test(content)) return { ok: false, field: "content", error: "A CNAME needs a hostname, like something.vercel-dns-017.com." };
    if (content === bare(r.name)) return { ok: false, field: "content", error: "A CNAME can't point to itself." };
  }
  if (r.type === "TXT" && (!content || content.length > TXT_MAX || !PRINTABLE.test(content))) {
    return { ok: false, field: "content", error: `TXT content is 1 to ${TXT_MAX.toLocaleString("en")} printable characters on one line.` };
  }
  const proxied = next.proxied === true;
  if (proxied && !canProxy(r.type)) return { ok: false, field: "proxied", error: "Only A, AAAA and CNAME records can be proxied." };
  const ttl = next.ttl;
  if (!Number.isInteger(ttl) || (ttl !== AUTO_TTL && (ttl < TTL_MIN || ttl > TTL_MAX))) {
    return { ok: false, field: "ttl", error: `TTL is Auto or ${TTL_MIN} to ${TTL_MAX.toLocaleString("en")} seconds.` };
  }
  // Cloudflare always uses Auto for a proxied record, whatever TTL is sent, so the console says so instead.
  return { ok: true, values: { content, ttl: proxied ? AUTO_TTL : ttl, proxied } };
}

const proxyText = (on: boolean) => (on ? "Proxied" : "DNS only");

export function planEdit(r: DnsRecord, next: RecordValues): { ok: true; values: RecordValues; changes: Change[] } | { ok: false; error: string } {
  const v = validateEdit(r, next);
  if (!v.ok) return { ok: false, error: v.error };
  const changes: Change[] = [];
  if (normalContent(r.type, r.content) !== v.values.content) changes.push({ field: "content", before: r.content, after: v.values.content });
  if (r.ttl !== v.values.ttl) changes.push({ field: "ttl", before: ttlText(r.ttl), after: ttlText(v.values.ttl) });
  if (r.proxied !== v.values.proxied) changes.push({ field: "proxied", before: proxyText(r.proxied), after: proxyText(v.values.proxied) });
  return changes.length ? { ok: true, values: v.values, changes } : { ok: false, error: "Nothing to change." };
}

// The stale-dialog guard: the record Cloudflare has now against the one the dialog showed.
export function sameRecord(live: Pick<DnsRecord, "type" | "content" | "ttl" | "proxied">, shown: RecordValues): boolean {
  return normalContent(live.type, live.content) === normalContent(live.type, String(shown.content ?? ""))
    && live.ttl === shown.ttl && live.proxied === shown.proxied;
}

export function withRecord(records: DnsRecord[], r: DnsRecord): DnsRecord[] {
  return records.map((x) => (x.id === r.id ? r : x));
}

const LABELS: Record<EditField, string> = { content: "content", ttl: "TTL", proxied: "proxy" };

// B6: the audit line. A proxy switch alone has its own wording; anything else is an edit. Our text only.
export function auditText(r: { type: string; name: string }, changes: Change[]): { message: string; detail: string } {
  const detail = changes.map((c) => `${LABELS[c.field]} ${c.before} → ${c.after}`).join(" · ");
  if (changes.length === 1 && changes[0].field === "proxied") {
    return { message: changes[0].after === "DNS only" ? `DNS: ${r.name} set to DNS only` : `DNS: ${r.name} proxied`, detail };
  }
  return { message: `DNS: ${r.type} ${r.name} edited`, detail };
}
