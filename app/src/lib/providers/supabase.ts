import { z } from "zod";
import { callJson, type FetchOpts, formatFailure, type Result } from "./http";

// Supabase Management API (https://api.supabase.com/api/v1-json, checked 12 Oct 2026). Reads, plus exactly the stage 6
// A1 writes: pause, restore, and the owner's keep-alive (`select 1` on the read-only query endpoint). The read-only
// size query (spec §7.2) runs only under sizeDue() (D1). Nothing here ever deletes.
const API = "https://api.supabase.com";
const NAME = "Supabase";
export const HEALTH_SERVICES = ["auth", "rest", "realtime", "storage", "db"] as const;
export const SIZE_QUERY = "select pg_database_size(current_database())::bigint as bytes";
export const KEEP_ALIVE_QUERY = "select 1";

export type SupabaseProject = { ref: string; name: string; orgSlug: string; region: string; createdAt: string; status: string; pgVersion: string | null };

const projectSchema = z.object({
  ref: z.string(), name: z.string(), region: z.string(), created_at: z.string(), status: z.string(),
  organization_slug: z.string().optional(), organization_id: z.string().optional(),
  database: z.object({ version: z.string().optional() }).nullish(),
});
const ref = (r: string) => encodeURIComponent(r);
const toProject = (x: z.infer<typeof projectSchema>): SupabaseProject => ({
  ref: x.ref, name: x.name, orgSlug: x.organization_slug ?? x.organization_id ?? "", region: x.region,
  createdAt: x.created_at, status: x.status, pgVersion: x.database?.version ?? null,
});

export async function listProjects(token: string, opts: FetchOpts = {}): Promise<Result<SupabaseProject[]>> {
  const r = await callJson(NAME, `${API}/v1/projects`, { token }, opts);
  if (!r.ok) return r;
  const p = z.array(projectSchema).safeParse(r.data);
  if (!p.success) return formatFailure(NAME, "the project list");
  return { ok: true, data: p.data.map(toProject) };
}

// Stage 6: the live status a pause or restore checks first.
export async function getProject(token: string, projectRef: string, opts: FetchOpts = {}): Promise<Result<SupabaseProject>> {
  const r = await callJson(NAME, `${API}/v1/projects/${ref(projectRef)}`, { token }, opts);
  if (!r.ok) return r;
  const p = projectSchema.safeParse(r.data);
  return p.success ? { ok: true, data: toProject(p.data) } : formatFailure(NAME, "the project");
}

// A6: a scoped token without Project admin write answers 403, with or without missing_permissions. Either way it is
// the token's scope, not a rejected credential (a 401 still is).
async function write(projectRef: string, verb: "pause" | "restore", token: string, opts: FetchOpts): Promise<Result<null>> {
  const r = await callJson(NAME, `${API}/v1/projects/${ref(projectRef)}/${verb}`, { method: "POST", token }, opts);
  if (r.ok) return { ok: true, data: null };
  if (r.status === 403 && r.kind !== "scope") return { ...r, kind: "scope", error: "Missing permission: project_admin_write." };
  return r;
}

// A1: POST /v1/projects/{ref}/pause, no body. Supabase stops the project in about 2 minutes; nothing is deleted.
export const pauseProject = (token: string, projectRef: string, opts: FetchOpts = {}) => write(projectRef, "pause", token, opts);
// A1: POST /v1/projects/{ref}/restore, no body. Needs a free slot in the org on the free plan.
export const restoreProject = (token: string, projectRef: string, opts: FetchOpts = {}) => write(projectRef, "restore", token, opts);

// A1/A8: the owner's opt-in keep-alive. One `select 1` through the read-only query endpoint (the one the size read
// uses), so the project sees database activity. Needs test: whether Supabase counts this as activity against
// auto-pause is not documented.
export async function keepAlive(token: string, projectRef: string, opts: FetchOpts = {}): Promise<Result<null>> {
  const r = await callJson(NAME, `${API}/v1/projects/${ref(projectRef)}/database/query/read-only`, { method: "POST", token, body: { query: KEEP_ALIVE_QUERY } }, opts);
  return r.ok ? { ok: true, data: null } : r;
}

export async function orgPlan(token: string, slug: string, opts: FetchOpts = {}): Promise<Result<string | null>> {
  const r = await callJson(NAME, `${API}/v1/organizations/${encodeURIComponent(slug)}`, { token }, opts);
  if (!r.ok) return r;
  const p = z.object({ plan: z.string().optional() }).safeParse(r.data);
  return p.success ? { ok: true, data: p.data.plan ?? null } : formatFailure(NAME, "the organization");
}

export async function serviceHealth(token: string, projectRef: string, opts: FetchOpts = {}): Promise<Result<{ name: string; status: string; error: string | null }[]>> {
  // One `services=` per service. No `timeout_ms`: the API rejects it with a 400 ("expected number, received string",
  // checked live on 13 Oct 2026); our own request timeout bounds the call instead.
  const q = new URLSearchParams(HEALTH_SERVICES.map((s) => ["services", s] as [string, string]));
  const r = await callJson(NAME, `${API}/v1/projects/${ref(projectRef)}/health?${q}`, { token }, opts);
  if (!r.ok) return r;
  const p = z.array(z.object({ name: z.string(), status: z.string(), error: z.string().optional() })).safeParse(r.data);
  return p.success ? { ok: true, data: p.data.map((s) => ({ name: s.name, status: s.status, error: s.error ?? null })) } : formatFailure(NAME, "service health");
}

const countsSchema = z.object({
  result: z.array(z.object({
    timestamp: z.string(),
    total_auth_requests: z.number(), total_realtime_requests: z.number(), total_rest_requests: z.number(), total_storage_requests: z.number(),
  })).optional(),
  error: z.unknown().optional(),
});

// 30 requests a minute (analytics endpoints). One call a project an hour.
export async function apiCounts(token: string, projectRef: string, opts: FetchOpts = {}): Promise<Result<{ at: Date; total: number }[]>> {
  const r = await callJson(NAME, `${API}/v1/projects/${ref(projectRef)}/analytics/endpoints/usage.api-counts?interval=7day`, { token }, opts);
  if (!r.ok) return r;
  const p = countsSchema.safeParse(r.data);
  if (!p.success) return formatFailure(NAME, "the API request counts");
  if (p.data.error) return { ok: false, kind: "transient", error: "Supabase couldn't read the API request counts this time." };
  return {
    ok: true,
    data: (p.data.result ?? []).map((b) => ({
      at: new Date(b.timestamp),
      total: b.total_auth_requests + b.total_realtime_requests + b.total_rest_requests + b.total_storage_requests,
    })),
  };
}

// The one query the console sends to a monitored database (spec §7.2): its size, read-only, once a day, and only
// while the project is active and already in use (D1).
export async function databaseSize(token: string, projectRef: string, opts: FetchOpts = {}): Promise<Result<number>> {
  const r = await callJson(NAME, `${API}/v1/projects/${ref(projectRef)}/database/query/read-only`, { method: "POST", token, body: { query: SIZE_QUERY } }, opts);
  if (!r.ok) return r;
  const p = z.array(z.object({ bytes: z.union([z.number(), z.string()]) })).min(1).safeParse(r.data);
  const n = p.success ? Number(p.data[0].bytes) : NaN;
  return Number.isFinite(n) ? { ok: true, data: n } : formatFailure(NAME, "the database size");
}

export type ScopeCheck = { used: string[]; missing: string[]; notes: string[] };

// What each permission feeds, shown when it's missing (mockup: Connections → Connect Supabase).
export const SCOPE_EFFECT: Record<string, string> = {
  project_admin_read: "Service health stays empty",
  analytics_usage_read: "Last API traffic and Auto-pause risk stay empty",
  organization_admin_read: "Free slots assume every organization is on the free plan",
  database_read: "Database size stays empty",
};

// D2: one call per permission the console reads, on one active project and its organization. database_read is not
// probed: testing it would run a query on a database.
export async function supabaseScopeCheck(token: string, projects: SupabaseProject[], opts: FetchOpts = {}): Promise<ScopeCheck> {
  const out: ScopeCheck = { used: ["projects_read"], missing: [], notes: [] };
  const active = projects.find((p) => p.status.startsWith("ACTIVE_"));
  const org = (active ?? projects[0])?.orgSlug;
  const probes: [string, Promise<Result<unknown>>][] = [];
  if (active) {
    probes.push(["project_admin_read", serviceHealth(token, active.ref, opts)]);
    probes.push(["analytics_usage_read", apiCounts(token, active.ref, opts)]);
  } else {
    out.notes.push("Health and API traffic are checked once a project is active");
  }
  if (org) probes.push(["organization_admin_read", orgPlan(token, org, opts)]);
  const results = await Promise.all(probes.map(([, p]) => p));
  probes.forEach(([perm], i) => {
    const r = results[i];
    if (r.ok) out.used.push(perm);
    else if (r.kind === "scope" || r.kind === "auth") out.missing.push(...(r.missing ?? [perm]));
    else out.notes.push(`${perm} couldn't be checked just now (${r.error})`);
  });
  out.notes.push("Database read is checked at the first daily size read");
  return out;
}
