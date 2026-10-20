import { z } from "zod";
import type { CertResult } from "./tls";
import type { CertPack, DnsRecord, RdapFact, TlsFact, VercelFact } from "./rules";

// snapshots.data is jsonb written by several tasks; every reader goes through here so a missing or odd key reads as
// "nothing known" instead of throwing or passing junk to the rules.

const tls = z.object({ notAfter: z.string().nullable(), issuer: z.string().nullable(), authorized: z.boolean().nullable(), error: z.string().nullable(), checkedAt: z.string() });
const vercel = z.object({ misconfigured: z.boolean(), configuredBy: z.string().nullable(), recommendedIps: z.array(z.string()).default([]), checkedAt: z.string() });
const rdap = z.object({ expiresAt: z.string().nullable(), registrar: z.string().nullable(), error: z.string().nullable(), checkedAt: z.string() });
const record = z.object({ id: z.string(), type: z.string(), name: z.string(), content: z.string(), proxied: z.boolean(), ttl: z.number(), comment: z.string().nullable() });
const zone = z.object({ status: z.string().nullable(), paused: z.boolean(), nameServers: z.array(z.string()), accountId: z.string().nullable(), checkedAt: z.string().nullable() });
const ssl = z.object({ mode: z.string().nullable(), error: z.string().nullable() });
const pack = z.object({ type: z.string(), status: z.string(), hosts: z.array(z.string()), expiresOn: z.string().nullable() });

const one = <T>(s: z.ZodType<T>, v: unknown): T | null => {
  const p = s.safeParse(v);
  return p.success ? p.data : null;
};
const many = <T>(s: z.ZodType<T>, v: unknown): T[] => (Array.isArray(v) ? v.flatMap((x) => { const p = s.safeParse(x); return p.success ? [p.data] : []; }) : []);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function factsOf(data: Record<string, unknown> | null | undefined) {
  const d = data ?? {};
  return {
    tls: one(tls, d.tls) as TlsFact | null,
    vercel: one(vercel, d.vercel) as VercelFact | null,
    rdap: one(rdap, d.rdap) as RdapFact | null,
    records: many(record, d.records) as DnsRecord[],
    recordsTruncated: d.recordsTruncated === true,
    zone: one(zone, d.zone),
    ssl: one(ssl, d.ssl),
    certs: many(pack, d.certs) as CertPack[],
    cfErrors: strings(d.cfErrors),
    reasons: strings(d.reasons),
  };
}

export function tlsFact(r: CertResult, prev: TlsFact | null, now: Date): TlsFact {
  const checkedAt = now.toISOString();
  if (r.ok) return { notAfter: r.notAfter.toISOString(), issuer: r.issuer, authorized: r.authorized, error: null, checkedAt };
  return { notAfter: prev?.notAfter ?? null, issuer: prev?.issuer ?? null, authorized: null, error: r.error, checkedAt };
}

export function rdapFact(
  r: { ok: true; expiresAt: string | null; registrar: string | null } | { ok: false; error: string }, prev: RdapFact | null, now: Date,
): RdapFact {
  const checkedAt = now.toISOString();
  if (r.ok) return { expiresAt: r.expiresAt, registrar: r.registrar, error: null, checkedAt };
  return { expiresAt: prev?.expiresAt ?? null, registrar: prev?.registrar ?? null, error: r.error, checkedAt };
}
