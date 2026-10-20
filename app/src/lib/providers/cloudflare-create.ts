import { z } from "zod";
import type { DnsRecord } from "@/lib/network/rules";

// Stage 6 create requests (owner 16 Oct): the ONLY Cloudflare create. POST /zones/{zone}/dns_records with one new A,
// AAAA, CNAME or TXT record, after the Owner's approval and a live check that the name is free. Nothing here can update
// (PATCH/PUT), batch (/dns_records/batch, /import) or delete anything; the adapter test pins the method and the path.
// Needs "Zone → DNS → Edit" on the token (the same permission as slice 2's edits). Only Cloudflare's numeric error code
// ever leaves here, never its message or body.

const BASE = "https://api.cloudflare.com/client/v4";
export const DNS_EDIT = "Zone → DNS → Edit";

export type CfCreateBody = { type: "A" | "AAAA" | "CNAME" | "TXT"; name: string; content: string; ttl: number; proxied?: boolean; comment?: string };
export type CfCreateResult =
  | { ok: true; data: DnsRecord }
  | { ok: false; kind: "auth" | "scope" | "missing" | "transient" | "format" | "refused"; error: string; status?: number; maybe?: boolean };

const envelope = z.object({ success: z.boolean(), result: z.unknown() });
const recordSchema = z.object({
  id: z.string(), type: z.string(), name: z.string(), content: z.string().default(""),
  proxied: z.boolean().default(false), ttl: z.number().default(1), comment: z.string().nullish(),
});
const errorCode = z.object({ errors: z.array(z.object({ code: z.number().int() })).min(1) });

export async function createDnsRecord(token: string, zoneId: string, body: CfCreateBody, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<CfCreateResult> {
  // proxied only goes with A, AAAA and CNAME; the record is always created DNS-only unless the Owner asked otherwise.
  const payload: CfCreateBody = { type: body.type, name: body.name, content: body.content, ttl: body.ttl, ...(body.type === "TXT" ? {} : { proxied: body.proxied === true }), comment: "Added from Watchbell" };
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${BASE}/zones/${encodeURIComponent(zoneId)}/dns_records`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      cache: "no-store",
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return timedOut
      ? { ok: false, kind: "transient", maybe: true, error: "Cloudflare didn't answer in time; the record may still have been added. Check the zone before asking again." }
      : { ok: false, kind: "transient", error: "Couldn't reach Cloudflare." };
  }
  const drop = () => res.body?.cancel().catch(() => undefined);
  if (res.status === 401) {
    await drop();
    return { ok: false, kind: "auth", status: 401, error: "Cloudflare rejected this credential (401)." };
  }
  if (res.status === 403) {
    await drop();
    return { ok: false, kind: "scope", status: 403, error: `This Cloudflare token can't add DNS records. Add "${DNS_EDIT}" to it, or replace it with a token that has it.` };
  }
  if (res.status === 404) {
    await drop();
    return { ok: false, kind: "missing", status: 404, error: "Cloudflare can't find this zone any more." };
  }
  const answer: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code = errorCode.safeParse(answer);
    // 81053/81054/81057/81058: a record with that name already exists or conflicts (the world changed since the check).
    return { ok: false, kind: res.status === 429 || res.status >= 500 ? "transient" : "refused", status: res.status, error: `Cloudflare refused this record (${res.status}${code.success ? `, code ${code.data.errors[0].code}` : ""}).` };
  }
  const env = envelope.safeParse(answer);
  const p = env.success && env.data.success ? recordSchema.safeParse(env.data.result) : null;
  if (!p?.success) return { ok: false, kind: "format", error: "Cloudflare added the record but answered in a format the console doesn't recognise. Check the zone." };
  const x = p.data;
  return { ok: true, data: { id: x.id, type: x.type, name: x.name, content: x.content, proxied: x.proxied, ttl: x.ttl, comment: x.comment ?? null } };
}
