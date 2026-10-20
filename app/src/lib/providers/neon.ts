import { z } from "zod";
import { callJson, type Failure, type FetchOpts, formatFailure, type Result } from "./http";

// Neon API v2 (https://neon.com/api_spec/release/v2.json, checked 12 Oct 2026). 700 requests/min per account, bursts
// of 40/s per route. Reads, plus one write (stage 6, plan A1): Wake = POST …/endpoints/{id}/start. Neon's other compute
// calls suspend or remove things, so they don't exist here. The console never opens a Postgres connection to Neon:
// that would wake the compute and burn CU-hours.
const API = "https://console.neon.tech/api/v2";
const NAME = "Neon";
const MAX_PAGES = 5;
const PAGE = 100;

export type NeonProjectItem = { id: string; name: string; region: string; pgVersion: number | null; orgId: string | null; createdAt: string };
export type NeonUsage = { computeSeconds: number; transferBytes: number; periodStart: string | null; periodEnd: string | null; region: string; pgVersion: number | null; lastActive: string | null; activeSeconds?: number | null };
export type NeonEndpoint = { id: string; branchId: string; state: string; pendingState: string | null; disabled: boolean; minCu: number; maxCu: number; lastActive: string | null };
export type NeonBranch = { id: string; name: string; isDefault: boolean; logicalSize: number | null };

const id = (v: string) => encodeURIComponent(v);

export async function listOrgs(token: string, opts: FetchOpts = {}): Promise<Result<{ id: string; name: string }[]>> {
  const r = await callJson(NAME, `${API}/users/me/organizations`, { token }, opts);
  if (!r.ok) return r;
  const p = z.object({ organizations: z.array(z.object({ id: z.string(), name: z.string() })) }).safeParse(r.data);
  return p.success ? { ok: true, data: p.data.organizations } : formatFailure(NAME, "the organization list");
}

const itemSchema = z.object({
  id: z.string(), name: z.string(), region_id: z.string(), pg_version: z.number().nullish(), created_at: z.string(), org_id: z.string().nullish(),
});

// A personal key must name the organization (org_id); an org or project key implies it.
export async function listNeonProjects(token: string, orgId: string | null, opts: FetchOpts = {}): Promise<Result<NeonProjectItem[]>> {
  const out: NeonProjectItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (orgId) q.set("org_id", orgId);
    if (cursor) q.set("cursor", cursor);
    const r = await callJson(NAME, `${API}/projects?${q}`, { token }, opts);
    if (!r.ok) return r;
    const p = z.object({ projects: z.array(itemSchema), pagination: z.object({ cursor: z.string().nullish() }).nullish() }).safeParse(r.data);
    if (!p.success) return formatFailure(NAME, "the project list");
    for (const x of p.data.projects) {
      out.push({ id: x.id, name: x.name, region: x.region_id, pgVersion: x.pg_version ?? null, orgId: x.org_id ?? orgId, createdAt: x.created_at });
    }
    cursor = p.data.pagination?.cursor ?? undefined;
    if (p.data.projects.length < PAGE || !cursor) break;
  }
  return { ok: true, data: out };
}

export async function discoverNeon(token: string, opts: FetchOpts = {}): Promise<Result<NeonProjectItem[]>> {
  const orgs = await listOrgs(token, opts);
  // A key that isn't tied to a user can't list "my" organizations; its project list needs no org_id.
  if (!orgs.ok && orgs.kind !== "missing" && orgs.kind !== "scope") return orgs;
  const orgIds: (string | null)[] = orgs.ok && orgs.data.length ? orgs.data.map((o) => o.id) : [null];
  const out: NeonProjectItem[] = [];
  for (const org of orgIds) {
    const r = await listNeonProjects(token, org, opts);
    if (!r.ok) return r;
    out.push(...r.data);
  }
  return { ok: true, data: out };
}

const usageSchema = z.object({
  project: z.object({
    region_id: z.string(), pg_version: z.number().nullish(),
    compute_time_seconds: z.number().nullish(), data_transfer_bytes: z.number().nullish(), active_time_seconds: z.number().nullish(),
    consumption_period_start: z.string().nullish(), consumption_period_end: z.string().nullish(), compute_last_active_at: z.string().nullish(),
  }),
});

// compute_time_seconds is this billing period's compute, CU-weighted (CU-hours = seconds / 3600). The free plan has
// no consumption-history API, so this project field is the source (neon.com/docs/introduction/plans).
export async function getNeonProject(token: string, projectId: string, opts: FetchOpts = {}): Promise<Result<NeonUsage>> {
  const r = await callJson(NAME, `${API}/projects/${id(projectId)}`, { token }, opts);
  if (!r.ok) return r;
  const p = usageSchema.safeParse(r.data);
  if (!p.success) return formatFailure(NAME, "the project");
  const x = p.data.project;
  return {
    ok: true,
    data: {
      computeSeconds: x.compute_time_seconds ?? 0, transferBytes: x.data_transfer_bytes ?? 0, activeSeconds: x.active_time_seconds ?? null,
      periodStart: x.consumption_period_start ?? null, periodEnd: x.consumption_period_end ?? null,
      region: x.region_id, pgVersion: x.pg_version ?? null, lastActive: x.compute_last_active_at ?? null,
    },
  };
}

const endpointSchema = z.object({
  id: z.string(), branch_id: z.string(), current_state: z.string(), pending_state: z.string().nullish(), disabled: z.boolean().nullish(),
  autoscaling_limit_min_cu: z.number(), autoscaling_limit_max_cu: z.number(), last_active: z.string().nullish(),
});

const toEndpoint = (e: z.infer<typeof endpointSchema>): NeonEndpoint => ({
  id: e.id, branchId: e.branch_id, state: e.current_state, pendingState: e.pending_state ?? null, disabled: e.disabled ?? false,
  minCu: e.autoscaling_limit_min_cu, maxCu: e.autoscaling_limit_max_cu, lastActive: e.last_active ?? null,
});

export async function listEndpoints(token: string, projectId: string, opts: FetchOpts = {}): Promise<Result<NeonEndpoint[]>> {
  const r = await callJson(NAME, `${API}/projects/${id(projectId)}/endpoints`, { token }, opts);
  if (!r.ok) return r;
  const p = z.object({ endpoints: z.array(endpointSchema) }).safeParse(r.data);
  if (!p.success) return formatFailure(NAME, "the compute list");
  return { ok: true, data: p.data.endpoints.map(toEndpoint) };
}

// One compute of the project, read live before a Wake. A compute of another project answers 404 (kind "missing").
export async function getEndpoint(token: string, projectId: string, endpointId: string, opts: FetchOpts = {}): Promise<Result<NeonEndpoint>> {
  const r = await callJson(NAME, `${API}/projects/${id(projectId)}/endpoints/${id(endpointId)}`, { token }, opts);
  if (!r.ok) return r;
  const p = z.object({ endpoint: endpointSchema }).safeParse(r.data);
  return p.success ? { ok: true, data: toEndpoint(p.data.endpoint) } : formatFailure(NAME, "the compute");
}

export type NeonBusy = { ok: false; kind: "busy"; status: 423; error: string };

// Wake (plan A1): the only write. POST with no body; the answer (the endpoint and its operations) isn't needed.
// 423 = another operation on the project is still running, which passes. A 403 means the key can't manage this
// project (Neon has no read-only keys), so it is a scope failure; the caller words it (A6).
export async function startEndpoint(token: string, projectId: string, endpointId: string, opts: FetchOpts = {}): Promise<Result<null> | NeonBusy> {
  const r = await callJson(NAME, `${API}/projects/${id(projectId)}/endpoints/${id(endpointId)}/start`, { method: "POST", token }, opts);
  if (r.ok) return { ok: true, data: null };
  if (r.status === 423) return { ok: false, kind: "busy", status: 423, error: "Neon is busy with another operation. Try again in a minute." };
  if (r.status === 403) return { ok: false, kind: "scope", status: 403, error: `${NAME} refused this request (403).` } satisfies Failure;
  return r;
}

const branchSchema = z.object({ id: z.string(), name: z.string(), default: z.boolean().nullish(), primary: z.boolean().nullish(), logical_size: z.number().nullish() });

export async function listBranches(token: string, projectId: string, opts: FetchOpts = {}): Promise<Result<NeonBranch[]>> {
  const r = await callJson(NAME, `${API}/projects/${id(projectId)}/branches`, { token }, opts);
  if (!r.ok) return r;
  const p = z.object({ branches: z.array(branchSchema) }).safeParse(r.data);
  if (!p.success) return formatFailure(NAME, "the branch list");
  return { ok: true, data: p.data.branches.map((b) => ({ id: b.id, name: b.name, isDefault: b.default ?? b.primary ?? false, logicalSize: b.logical_size ?? null })) };
}
