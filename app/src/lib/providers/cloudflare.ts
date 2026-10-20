import { z } from "zod";
import type { CertPack, DnsRecord } from "@/lib/network/rules";

// Cloudflare API v4. Reads are GETs with the account's API token. The one write is a stage 6 action (slice 2, B1): a
// PATCH of one existing DNS record (updateDnsRecord). Nothing here can create (POST), replace (PUT) or delete anything.
// A 401/403 on the zone list means the token is bad; a 403 on a per-zone call means one permission is missing
// ("scope"), which the UI shows as "Unknown" for that part only.

export type CfFailure = { ok: false; kind: "auth" | "scope" | "transient" | "format"; error: string; status?: number; retryAfterS?: number };
export type CfResult<T> = { ok: true; data: T } | CfFailure;
export type CfOpts = { fetch?: typeof fetch; timeoutMs?: number };
export type CfZone = { id: string; name: string; status: string; paused: boolean; nameServers: string[]; accountId: string | null; accountName: string | null };

const BASE = "https://api.cloudflare.com/client/v4";
const MAX_ZONE_PAGES = 10;
export const RECORDS_PER_PAGE = 500;
export const MAX_RECORD_PAGES = 4;

const envelope = z.object({
  success: z.boolean(),
  result: z.unknown(),
  result_info: z.object({ page: z.number().optional(), total_pages: z.number().optional() }).nullish(),
});

async function get(path: string, token: string, opts: CfOpts, permission: string | null): Promise<CfResult<{ result: unknown; totalPages: number | null }>> {
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${BASE}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      cache: "no-store",
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, kind: "transient", error: timedOut ? "Cloudflare didn't answer within 5 seconds." : "Couldn't reach Cloudflare." };
  }
  if (res.status === 403 && permission) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, kind: "scope", status: 403, error: `The token can't read this. Add "${permission}" to the Cloudflare token.` };
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, kind: "auth", status: res.status, error: `Cloudflare rejected this credential (${res.status}).` };
  }
  if (res.status === 429) {
    const retry = Number(res.headers.get("Retry-After"));
    return { ok: false, kind: "transient", status: 429, retryAfterS: Number.isFinite(retry) && retry > 0 ? retry : 60, error: "Cloudflare says there were too many requests." };
  }
  if (!res.ok) return { ok: false, kind: "transient", status: res.status, error: `Cloudflare returned an error (${res.status}).` };
  const body = envelope.safeParse(await res.json().catch(() => null));
  if (!body.success || !body.data.success) return format("its answer");
  return { ok: true, data: { result: body.data.result, totalPages: body.data.result_info?.total_pages ?? null } };
}

const format = (what: string): CfFailure => ({ ok: false, kind: "format", error: `Cloudflare answered ${what} in a format the console doesn't recognise.` });
const id = (v: string) => encodeURIComponent(v);

const zoneSchema = z.object({
  id: z.string(), name: z.string(), status: z.string(), paused: z.boolean().default(false),
  name_servers: z.array(z.string()).default([]),
  account: z.object({ id: z.string(), name: z.string().nullish() }).nullish(),
});

export async function listZones(token: string, opts: CfOpts = {}): Promise<CfResult<CfZone[]>> {
  const out: CfZone[] = [];
  for (let page = 1; page <= MAX_ZONE_PAGES; page++) {
    const r = await get(`/zones?per_page=50&page=${page}`, token, opts, null);
    if (!r.ok) return r;
    const p = z.array(zoneSchema).safeParse(r.data.result);
    if (!p.success) return format("the zone list");
    for (const x of p.data) {
      out.push({ id: x.id, name: x.name, status: x.status, paused: x.paused, nameServers: x.name_servers, accountId: x.account?.id ?? null, accountName: x.account?.name ?? null });
    }
    if (!r.data.totalPages || page >= r.data.totalPages) break;
  }
  return { ok: true, data: out };
}

const recordSchema = z.object({
  id: z.string(), type: z.string(), name: z.string(), content: z.string().default(""),
  proxied: z.boolean().default(false), ttl: z.number().default(1), comment: z.string().nullish(),
});

export async function listDnsRecords(token: string, zoneId: string, opts: CfOpts = {}): Promise<CfResult<{ records: DnsRecord[]; truncated: boolean }>> {
  const records: DnsRecord[] = [];
  for (let page = 1; page <= MAX_RECORD_PAGES; page++) {
    const r = await get(`/zones/${id(zoneId)}/dns_records?per_page=${RECORDS_PER_PAGE}&page=${page}`, token, opts, "DNS Read");
    if (!r.ok) return r;
    const p = z.array(recordSchema).safeParse(r.data.result);
    if (!p.success) return format("the DNS records");
    records.push(...p.data.map((x) => ({ id: x.id, type: x.type, name: x.name, content: x.content, proxied: x.proxied, ttl: x.ttl, comment: x.comment ?? null })));
    if (!r.data.totalPages || page >= r.data.totalPages) return { ok: true, data: { records, truncated: false } };
  }
  return { ok: true, data: { records, truncated: true } };
}

// ---------- Stage 6 slice 2: one record's live read, then the only write (plan B1) ----------

export type CfWriteFailure = { ok: false; kind: "auth" | "scope" | "missing" | "transient" | "format"; error: string; status?: number; retryAfterS?: number };
export type CfWriteResult<T> = { ok: true; data: T } | CfWriteFailure;
export type RecordBody = { type: string; name: string; content: string; ttl: number; proxied?: boolean };

const EDIT_PERMISSION = "Zone → DNS → Edit";
const errorCode = z.object({ errors: z.array(z.object({ code: z.number().int() })).min(1) });

// GET or PATCH of one record. Only Cloudflare's numeric error code ever leaves here, never its message or body.
async function recordCall(method: "GET" | "PATCH", path: string, token: string, body: RecordBody | undefined, opts: CfOpts): Promise<CfWriteResult<DnsRecord>> {
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      cache: "no-store",
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    if (!timedOut) return { ok: false, kind: "transient", error: "Couldn't reach Cloudflare." };
    return {
      ok: false, kind: "transient",
      error: method === "PATCH" ? "Cloudflare didn't answer within 5 seconds; the change may still have happened. Reload in a minute." : "Cloudflare didn't answer within 5 seconds.",
    };
  }
  const drop = () => res.body?.cancel().catch(() => undefined);
  if (res.status === 401) {
    await drop();
    return { ok: false, kind: "auth", status: 401, error: "Cloudflare rejected this credential (401)." };
  }
  if (res.status === 403) {
    await drop();
    const permission = method === "PATCH" ? EDIT_PERMISSION : "DNS Read";
    return { ok: false, kind: "scope", status: 403, error: `The token can't ${method === "PATCH" ? "edit" : "read"} this record. Add "${permission}" to the Cloudflare token.` };
  }
  if (res.status === 404) {
    await drop();
    return { ok: false, kind: "missing", status: 404, error: "Cloudflare can't find this record any more." };
  }
  if (res.status === 429) {
    await drop();
    return { ok: false, kind: "transient", status: 429, retryAfterS: retryAfter(res), error: "Cloudflare says there were too many requests." };
  }
  const answer: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code = errorCode.safeParse(answer);
    return { ok: false, kind: "transient", status: res.status, error: `Cloudflare refused this change (${res.status}${code.success ? `, code ${code.data.errors[0].code}` : ""}).` };
  }
  const env = envelope.safeParse(answer);
  if (!env.success || !env.data.success) return format("the DNS record");
  const p = recordSchema.safeParse(env.data.result);
  if (!p.success) return format("the DNS record");
  const x = p.data;
  return { ok: true, data: { id: x.id, type: x.type, name: x.name, content: x.content, proxied: x.proxied, ttl: x.ttl, comment: x.comment ?? null } };
}

const retryAfter = (res: Response) => {
  const retry = Number(res.headers.get("Retry-After"));
  return Number.isFinite(retry) && retry > 0 ? retry : 60;
};

// The record as Cloudflare has it now: the stale-dialog guard reads this right before the write.
export async function getDnsRecord(token: string, zoneId: string, recordId: string, opts: CfOpts = {}): Promise<CfWriteResult<DnsRecord>> {
  return recordCall("GET", `/zones/${id(zoneId)}/dns_records/${id(recordId)}`, token, undefined, opts);
}

// The only Cloudflare write (B1): PATCH one existing record. The caller sends the live record's own type and name, so a
// record is never retyped or renamed; `proxied` goes only with A, AAAA and CNAME.
export async function updateDnsRecord(token: string, zoneId: string, recordId: string, body: RecordBody, opts: CfOpts = {}): Promise<CfWriteResult<DnsRecord>> {
  return recordCall("PATCH", `/zones/${id(zoneId)}/dns_records/${id(recordId)}`, token, body, opts);
}

export async function sslMode(token: string, zoneId: string, opts: CfOpts = {}): Promise<CfResult<string>> {
  const r = await get(`/zones/${id(zoneId)}/settings/ssl`, token, opts, "Zone Settings Read");
  if (!r.ok) return r;
  const p = z.object({ value: z.string() }).safeParse(r.data.result);
  return p.success ? { ok: true, data: p.data.value } : format("the SSL/TLS mode");
}

const packSchema = z.object({
  type: z.string(), status: z.string(), hosts: z.array(z.string()).default([]),
  certificates: z.array(z.object({ expires_on: z.string().nullish() })).default([]),
});

export async function certificatePacks(token: string, zoneId: string, opts: CfOpts = {}): Promise<CfResult<CertPack[]>> {
  const r = await get(`/zones/${id(zoneId)}/ssl/certificate_packs?status=all&per_page=50`, token, opts, "SSL and Certificates Read");
  if (!r.ok) return r;
  const p = z.array(packSchema).safeParse(r.data.result);
  if (!p.success) return format("the edge certificates");
  return {
    ok: true,
    data: p.data.map((x) => {
      const dates = x.certificates.map((c) => c.expires_on).filter((d): d is string => !!d).sort();
      return { type: x.type, status: x.status, hosts: x.hosts, expiresOn: dates[0] ?? null };
    }),
  };
}

export async function tokenStatus(token: string, opts: CfOpts = {}): Promise<CfResult<{ status: string; expiresAt: Date | null }>> {
  const r = await get("/user/tokens/verify", token, opts, null);
  if (!r.ok) return r;
  const p = z.object({ status: z.string(), expires_on: z.string().nullish() }).safeParse(r.data.result);
  if (!p.success) return format("the token details");
  const at = p.data.expires_on ? new Date(p.data.expires_on) : null;
  return { ok: true, data: { status: p.data.status, expiresAt: at && !Number.isNaN(at.getTime()) ? at : null } };
}
