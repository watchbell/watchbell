import "server-only";
import { driveEnv, refreshAccessToken } from "@/lib/backup/google-oauth";
import type { CreateOptions, CreateType } from "@/lib/create/types";

export type { CreateOptions };
import { GCP_QUOTA_HINT } from "@/lib/create/validate";
import type { ActionResult } from "@/lib/action";
import { createGrantConnected, listAccounts, loadAccount, readCreateGrant } from "@/lib/data/create-db";
import { loadTarget } from "@/lib/data/provider-action-db";
import { NEON_FREE } from "@/lib/databases/neon";
import { FREE_SLOTS, usesSlot } from "@/lib/databases/supabase";
import { listGcpProjects } from "@/lib/providers/gcp-create";
import { listBranches } from "@/lib/providers/neon";
import { listProjects, orgPlan } from "@/lib/providers/supabase";
import { CREATE_PERMISSION, listOrganizations } from "@/lib/providers/supabase-create";

// Stage 6 create requests: what a create dialog offers, read live when it opens (reads only). The real checks run
// again on the request and at approval; these are for choosing and for honest numbers up front.

export const SUPABASE_SCOPE_NOTE = `Creating needs the token's "${CREATE_PERMISSION}" permission (Organization → Projects → Create), plus "organizations_read" and "organization_admin_read" so the console can confirm the free plan. A token from Account → Access Tokens has them; a fine-grained token needs them added.`;

export async function createOptions(type: CreateType, target: string): Promise<ActionResult<CreateOptions>> {
  switch (type) {
    case "dns_record":
      return { ok: true, data: { type } };
    case "neon_branch": {
      const t = await loadTarget(target, "neon_project");
      if (!t) return { ok: false, error: "This project isn't watched any more. Reload the page." };
      const b = await listBranches(t.token, t.resource.externalId);
      if (!b.ok) return { ok: false, error: `Couldn't read the branches just now: ${b.error}` };
      return { ok: true, data: { type, branches: b.data.map((x) => ({ id: x.id, name: x.name, isDefault: x.isDefault })), limit: NEON_FREE.branches } };
    }
    case "supabase_project": {
      const accounts = await listAccounts("supabase");
      const accountId = accounts.some((a) => a.id === target) ? target : accounts[0]?.id ?? null;
      const base = { type, accounts, accountId, orgs: [], active: 0, limit: FREE_SLOTS, scopeNote: SUPABASE_SCOPE_NOTE } as const;
      if (!accountId) return { ok: true, data: { ...base, orgs: [] } };
      const a = await loadAccount(accountId, "supabase");
      if (!a) return { ok: true, data: { ...base, orgs: [], error: "This account's credential can't be read." } };
      const [orgs, projects] = await Promise.all([listOrganizations(a.token), listProjects(a.token)]);
      if (!orgs.ok) return { ok: true, data: { ...base, orgs: [], error: orgs.kind === "scope" ? "This token can't list organizations." : orgs.error } };
      const plans = await Promise.all(orgs.data.map(async (o) => {
        const p = await orgPlan(a.token, o.slug);
        return { slug: o.slug, name: o.name, plan: p.ok ? p.data : null };
      }));
      const paid = new Set(plans.filter((p) => p.plan && p.plan !== "free").map((p) => p.slug));
      const active = projects.ok ? projects.data.filter((p) => !paid.has(p.orgSlug) && usesSlot(p.status)).length : 0;
      return { ok: true, data: { ...base, orgs: plans.map((p) => ({ ...p, allowed: p.plan === "free" })), active } };
    }
    case "firebase_project": {
      const envReady = !!driveEnv();
      const connectedAt = await createGrantConnected();
      const base = { type, envReady, connected: connectedAt !== null, connectedAt, projects: null, quotaHint: GCP_QUOTA_HINT } as const;
      if (!envReady || connectedAt === null) return { ok: true, data: { ...base } };
      const grant = await readCreateGrant();
      const env = driveEnv();
      const tok = grant && env ? await refreshAccessToken(env, grant.refreshToken) : null;
      if (!tok?.ok) return { ok: true, data: { ...base, error: "Google ended the grant (Testing mode lasts 7 days, or it was removed). Connect again." } };
      const list = await listGcpProjects(tok.accessToken);
      if (!list.ok) return { ok: true, data: { ...base, error: `Couldn't read your Google Cloud projects: ${list.error}` } };
      return { ok: true, data: { ...base, projects: list.data.filter((p) => p.state === "ACTIVE").length } };
    }
  }
}
