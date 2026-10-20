import { z } from "zod";
import { callJson, type FetchOpts, formatFailure, type Result } from "./http";

// Stage 6 create requests (owner 16 Oct): the organizations a token can see (read), and the ONLY Supabase create:
// POST /v1/projects (api.supabase.com/api/v1-json, checked 16 Oct 2026: x-fga-permissions "organization_projects_create",
// OAuth scope projects:write). The organization list needs "organizations_read" and each plan (GET
// /v1/organizations/{slug}, lib/providers/supabase.ts orgPlan) "organization_admin_read". Nothing here updates or deletes.
//
// The database password goes to Supabase in the request body and nowhere else: this function never logs, returns or
// stores it, and the caller shows it once to the Owner.

const API = "https://api.supabase.com";
const NAME = "Supabase";
export const CREATE_PERMISSION = "organization_projects_create";

export type SupabaseOrg = { slug: string; name: string };

export async function listOrganizations(token: string, opts: FetchOpts = {}): Promise<Result<SupabaseOrg[]>> {
  const r = await callJson(NAME, `${API}/v1/organizations`, { token }, opts);
  if (!r.ok) return r;
  const p = z.array(z.object({ slug: z.string().optional(), id: z.string().optional(), name: z.string() })).safeParse(r.data);
  if (!p.success) return formatFailure(NAME, "the organization list");
  return { ok: true, data: p.data.map((o) => ({ slug: o.slug ?? o.id ?? "", name: o.name })).filter((o) => o.slug) };
}

export type NewProject = { ref: string; name: string; status: string; region: string };

export async function createProject(token: string, p: { orgSlug: string; name: string; region: string; dbPass: string }, opts: FetchOpts = {}): Promise<Result<NewProject>> {
  // No desired_instance_size: Supabase then picks the smallest size, the free one. No plan field (set per organization).
  const body = { name: p.name, organization_slug: p.orgSlug, region_selection: { type: "specific", code: p.region }, db_pass: p.dbPass };
  const r = await callJson(NAME, `${API}/v1/projects`, { method: "POST", token, body }, { timeoutMs: 20_000, ...opts });
  if (!r.ok) {
    // Never pass Supabase's own message on: it could echo the request.
    if (r.status === 403) return { ok: false, kind: "scope", status: 403, missing: r.missing ?? [CREATE_PERMISSION], error: `This Supabase token can't create projects. Add the "${CREATE_PERMISSION}" permission (Organization → Projects → Create).` };
    const { message: _m, ...rest } = r;
    void _m;
    return rest;
  }
  const x = z.object({ ref: z.string().optional(), id: z.string().optional(), name: z.string(), status: z.string().default("COMING_UP"), region: z.string().default(p.region) }).safeParse(r.data);
  if (!x.success || !(x.data.ref ?? x.data.id)) return formatFailure(NAME, "the new project");
  return { ok: true, data: { ref: (x.data.ref ?? x.data.id) as string, name: x.data.name, status: x.data.status, region: x.data.region } };
}
