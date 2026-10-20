import { z } from "zod";
import { callJson, type FetchOpts, formatFailure, type Result } from "./http";

// Turso Platform API (docs.turso.tech/api-reference, checked 16 Oct 2026). Bearer platform API token. Reads only:
//   GET /v1/organizations                         slug, plan_id, blocked_reads, blocked_writes
//   GET /v1/organizations/{org}/databases         Name, DbId, Hostname, group, primaryRegion, block_reads/writes
//   GET /v1/organizations/{org}/usage             this month's rows read/written and storage, org-wide and per database
// Turso has no read-only platform token (a read-only token is a database/group token, which can't list anything), so
// the owner should mint one limited to one organization: `turso auth api-tokens mint watchbell --org <org>`.
const API = "https://api.turso.tech/v1";
const NAME = "Turso";

export type TursoOrg = { slug: string; name: string; plan: string | null; blockedReads: boolean; blockedWrites: boolean };
export type TursoDb = { id: string; name: string; org: string; group: string | null; primaryRegion: string | null; blockReads: boolean; blockWrites: boolean };
export type TursoUsage = { rowsRead: number; rowsWritten: number; storageBytes: number };
export type TursoOrgUsage = { org: TursoUsage & { databases: number | null }; byDb: Map<string, TursoUsage> };

const slug = (v: string) => encodeURIComponent(v);

const orgSchema = z.object({
  slug: z.string(), name: z.string().default(""), plan_id: z.string().nullish(),
  blocked_reads: z.boolean().nullish(), blocked_writes: z.boolean().nullish(),
});

export async function listTursoOrgs(token: string, opts: FetchOpts = {}): Promise<Result<TursoOrg[]>> {
  const r = await callJson(NAME, `${API}/organizations`, { token }, opts);
  if (!r.ok) return r;
  const p = z.array(orgSchema).safeParse(r.data);
  if (!p.success) return formatFailure(NAME, "the organization list");
  return { ok: true, data: p.data.map((o) => ({ slug: o.slug, name: o.name || o.slug, plan: o.plan_id ?? null, blockedReads: o.blocked_reads ?? false, blockedWrites: o.blocked_writes ?? false })) };
}

const dbSchema = z.object({
  Name: z.string(), DbId: z.string(), group: z.string().nullish(), primaryRegion: z.string().nullish(),
  block_reads: z.boolean().nullish(), block_writes: z.boolean().nullish(),
});

export async function listTursoDatabases(token: string, org: string, opts: FetchOpts = {}): Promise<Result<TursoDb[]>> {
  const r = await callJson(NAME, `${API}/organizations/${slug(org)}/databases`, { token }, opts);
  if (!r.ok) return r;
  const p = z.object({ databases: z.array(dbSchema) }).safeParse(r.data);
  if (!p.success) return formatFailure(NAME, "the database list");
  return {
    ok: true,
    data: p.data.databases.map((d) => ({
      id: d.DbId, name: d.Name, org, group: d.group ?? null, primaryRegion: d.primaryRegion ?? null, blockReads: d.block_reads ?? false, blockWrites: d.block_writes ?? false,
    })),
  };
}

// Every organization the token can see, then its databases. A token limited to one organization lists just that one.
export async function discoverTurso(token: string, opts: FetchOpts = {}): Promise<Result<TursoDb[]>> {
  const orgs = await listTursoOrgs(token, opts);
  if (!orgs.ok) return orgs;
  const out: TursoDb[] = [];
  for (const o of orgs.data.slice(0, 10)) {
    const r = await listTursoDatabases(token, o.slug, opts);
    if (!r.ok) return r;
    out.push(...r.data);
  }
  return { ok: true, data: out };
}

const usageNums = z.object({ rows_read: z.number().default(0), rows_written: z.number().default(0), storage_bytes: z.number().default(0) });
const orgUsageSchema = z.object({
  organization: z.object({ usage: usageNums.extend({ databases: z.number().nullish() }) }),
  databases: z.array(z.object({ uuid: z.string(), total: usageNums.nullish() })).nullish(),
});

const usage = (u: z.infer<typeof usageNums>): TursoUsage => ({ rowsRead: u.rows_read, rowsWritten: u.rows_written, storageBytes: u.storage_bytes });

// Pure: the org usage answer (this calendar month by default).
export function parseTursoOrgUsage(body: unknown): Result<TursoOrgUsage> {
  const p = orgUsageSchema.safeParse(body);
  if (!p.success) return formatFailure(NAME, "the usage");
  const byDb = new Map<string, TursoUsage>();
  for (const d of p.data.databases ?? []) if (d.total) byDb.set(d.uuid, usage(d.total));
  return { ok: true, data: { org: { ...usage(p.data.organization.usage), databases: p.data.organization.usage.databases ?? null }, byDb } };
}

export async function tursoOrgUsage(token: string, org: string, opts: FetchOpts = {}): Promise<Result<TursoOrgUsage>> {
  const r = await callJson(NAME, `${API}/organizations/${slug(org)}/usage`, { token }, opts);
  return r.ok ? parseTursoOrgUsage(r.data) : r;
}
