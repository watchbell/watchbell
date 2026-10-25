import { z } from "zod";
import { cleanRootDir, unusableRootDir } from "@/lib/deps/root-dir";

export type VercelFailure = { ok: false; kind: "auth" | "transient" | "format"; error: string; status?: number; retryAfterS?: number };
export type Result<T> = { ok: true; data: T } | VercelFailure;
// Stage 6 writes add "scope": a 403 on a write means the token can't change projects in that team (reads keep 403 = auth).
export type VercelWriteFailure = Omit<VercelFailure, "kind"> & { kind: VercelFailure["kind"] | "scope" };
export type WriteResult<T> = { ok: true; data: T } | VercelWriteFailure;
export type VercelOpts = { fetch?: typeof fetch; timeoutMs?: number };
export type VercelTeam = { id: string; slug: string; name: string };
export type DeploymentState = "ready" | "building" | "error" | "canceled";
export type VercelProject = { id: string; name: string; team: VercelTeam; framework: string | null; createdAt: Date; productionBranch: string | null; currentDeploymentId: string | null;
  repo: { type: string; org: string; repo: string } | null; functionRegions: string[];
  // Watchbell 1.2: the project's Root Directory in its repository ("apps/web"), null at the root.
  rootDirectory: string | null;
  // Watchbell 1.2.1 (review T1): a Root Directory Vercel has that Watchbell can't use ("my app", too deep), as text for
  // the Dependencies card and the PR refusal; null otherwise.
  rootDirectoryUnsupported: string | null;
  // Watchbell 1.2.1: targets.production.alias, the names production is served on (chooseProductionDomain).
  productionAliases: string[];
};
export type VercelDeployment = {
  id: string; projectId: string; state: DeploymentState; rawState: string; target: "production" | "preview";
  branch: string | null; sha: string | null; message: string | null; source: string | null; url: string | null;
  createdAt: Date; buildingAt: Date | null; readyAt: Date | null;
};
export type DiscoveredApp = {
  externalId: string; name: string;
  meta: { teamId: string; teamSlug: string; teamName: string; framework: string | null; productionBranch: string | null; createdAt: string; repo: string | null; repoType: string | null; functionRegions: string[]; rootDirectory: string | null; rootDirectoryUnsupported?: string; productionAliases?: string[] };
};

const BASE = "https://api.vercel.com";
const MAX_PAGES = 10;

async function get(path: string, token: string, opts: VercelOpts): Promise<Result<unknown>> {
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      cache: "no-store",
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, kind: "transient", error: timedOut ? "Vercel didn't answer within 5 seconds." : "Couldn't reach Vercel." };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, kind: "auth", status: res.status, error: `Vercel rejected this credential (${res.status}).` };
  if (res.status === 429) {
    const retry = Number(res.headers.get("Retry-After"));
    return { ok: false, kind: "transient", status: 429, retryAfterS: Number.isFinite(retry) && retry > 0 ? retry : 60, error: "Vercel says there were too many requests." };
  }
  if (!res.ok) return { ok: false, kind: "transient", status: res.status, error: `Vercel returned an error (${res.status}).` };
  const body: unknown = await res.json().catch(() => null);
  return { ok: true, data: body };
}

const retryAfter = (res: Response) => {
  const retry = Number(res.headers.get("Retry-After"));
  return Number.isFinite(retry) && retry > 0 ? retry : 60;
};

// Stage 6 writes (spec §12, plan A1; slice 2 B1). The only methods are POST and PATCH, and the only callers are the five
// functions below; no other method can be expressed. A 403 means this token can't change the team's projects ("scope"); the answer's
// body is never passed on, only Vercel's short error code (letters, digits, - and _).
async function send(method: "POST" | "PATCH", path: string, token: string, body: unknown, opts: VercelOpts): Promise<WriteResult<unknown>> {
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      cache: "no-store",
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      ok: false, kind: "transient",
      error: timedOut ? "Vercel didn't answer within 5 seconds; the action may still have happened. Check the deployments in a minute." : "Couldn't reach Vercel.",
    };
  }
  if (res.status === 401) return { ok: false, kind: "auth", status: 401, error: "Vercel rejected this credential (401)." };
  if (res.status === 403) return { ok: false, kind: "scope", status: 403, error: "Vercel refused this token for that project (403)." };
  if (res.status === 429) return { ok: false, kind: "transient", status: 429, retryAfterS: retryAfter(res), error: "Vercel says there were too many requests." };
  const answer: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code = z.object({ error: z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/) }) }).safeParse(answer);
    return { ok: false, kind: "transient", status: res.status, error: `Vercel refused this (${res.status}${code.success ? `, ${code.data.error.code}` : ""}).` };
  }
  return { ok: true, data: answer };
}

const teamQ = (teamId: string) => `teamId=${encodeURIComponent(teamId)}`;
const seg = encodeURIComponent;

const format = (what: string): VercelFailure => ({ ok: false, kind: "format", error: `Vercel answered ${what} in a format the console doesn't recognise.` });

export function mapDeploymentState(raw: string): DeploymentState {
  if (raw === "READY") return "ready";
  if (raw === "ERROR") return "error";
  if (raw === "CANCELED") return "canceled";
  return "building";
}

// The domain Vercel serves production on (1.2.1, the shopfront move). Usable: verified, no redirect, no preview
// branch, no custom environment. Among those: the one other listed domains redirect to (an old domain moved to it),
// then a custom domain over vercel.app, then one the production deployment carries as an alias, then the shorter name
// (a "demo-" or "www." variant loses), then list order. None usable: <name>.vercel.app.
export function chooseProductionDomain(
  domains: { name: string; redirect?: string | null; verified?: boolean; gitBranch?: string | null; customEnvironmentId?: string | null }[],
  projectName: string,
  productionAliases: string[] = [],
): string {
  const usable = domains.filter((d) => d.verified !== false && !d.redirect && !d.gitBranch && !d.customEnvironmentId);
  const aliases = new Set(productionAliases.map((a) => a.toLowerCase()));
  const score = (name: string) => [
    domains.some((d) => d.redirect?.toLowerCase() === name.toLowerCase()) ? 0 : 1,
    name.endsWith(".vercel.app") ? 1 : 0,
    aliases.has(name.toLowerCase()) ? 0 : 1,
    name.length,
  ];
  const ranked = usable.map((d, i) => ({ name: d.name, key: [...score(d.name), i] }))
    .sort((a, b) => { for (let k = 0; k < a.key.length; k++) if (a.key[k] !== b.key[k]) return a.key[k] - b.key[k]; return 0; });
  return ranked[0]?.name ?? `${projectName}.vercel.app`;
}

const teamsSchema = z.object({ teams: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string().nullish() })) });

export async function listTeams(token: string, opts: VercelOpts = {}): Promise<Result<VercelTeam[]>> {
  const r = await get("/v2/teams?limit=100", token, opts);
  if (!r.ok) return r;
  const p = teamsSchema.safeParse(r.data);
  return p.success ? { ok: true, data: p.data.teams.map((t) => ({ id: t.id, slug: t.slug, name: t.name ?? t.slug })) } : format("the team list");
}

export async function tokenExpiry(token: string, opts: VercelOpts = {}): Promise<Result<Date | null>> {
  const r = await get("/v5/user/tokens/current", token, opts);
  if (!r.ok) return r;
  const p = z.object({ token: z.object({ expiresAt: z.number().nullish() }) }).safeParse(r.data);
  return p.success ? { ok: true, data: p.data.token.expiresAt ? new Date(p.data.token.expiresAt) : null } : format("the token details");
}

// The production deployment Vercel serves. `targets.production` is the latest production deployment (spec §7.1): it
// counts only when READY (else the caller falls back to the newest READY one). A roll back moves production to an older
// deployment and stops auto-assigning it until a promote, so after a succeeded roll back the live one is its target,
// whatever was built since (stage 6, A9). After a succeeded promote its target is live until a production deployment
// created later (auto-assigned again) takes over. Unfinished or unknown alias requests change nothing.
const productionTargetSchema = z.object({
  id: z.string(), readyState: z.string().nullish(), createdAt: z.number().nullish().catch(null),
  alias: z.array(z.string()).nullish().catch(null), // 1.2.1: the names the production deployment is served on
}).nullish();
const aliasRequestSchema = z.object({
  type: z.string(), jobStatus: z.string(), toDeploymentId: z.string(), requestedAt: z.number(),
}).nullish().catch(null);

function servingId(latest: z.infer<typeof productionTargetSchema>, last: z.infer<typeof aliasRequestSchema>): string | null {
  const ready = latest?.readyState === "READY" ? latest.id : null;
  if (!last || last.jobStatus !== "succeeded") return ready;
  if (last.type === "rollback") return last.toDeploymentId;
  if (last.type === "promote" && typeof latest?.createdAt === "number" && latest.createdAt <= last.requestedAt) return last.toDeploymentId;
  return ready;
}

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  framework: z.string().nullish(),
  createdAt: z.number(),
  link: z.object({ productionBranch: z.string().nullish(), type: z.string().nullish(), org: z.string().nullish(), repo: z.string().nullish() }).nullish(),
  resourceConfig: z.object({ functionDefaultRegions: z.array(z.string()).nullish() }).nullish(),
  targets: z.object({ production: productionTargetSchema }).nullish(),
  lastAliasRequest: aliasRequestSchema,
  rootDirectory: z.string().nullish().catch(null),
});
const projectsPage = z.object({ projects: z.array(projectSchema), pagination: z.object({ next: z.number().nullish() }).nullish() });

export async function listProjects(token: string, team: VercelTeam, opts: VercelOpts = {}): Promise<Result<VercelProject[]>> {
  const out: VercelProject[] = [];
  let until: number | null | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await get(`/v10/projects?teamId=${encodeURIComponent(team.id)}&limit=100${until ? `&until=${until}` : ""}`, token, opts);
    if (!r.ok) return r;
    const p = projectsPage.safeParse(r.data);
    if (!p.success) return format("the project list");
    for (const x of p.data.projects) {
      out.push({
        id: x.id, name: x.name, team, framework: x.framework ?? null, createdAt: new Date(x.createdAt),
        productionBranch: x.link?.productionBranch ?? null,
        // targets.production is the latest production deployment, which can be a failed one while an older READY one is
        // live, or a newer one than the live one after a roll back (servingId).
        currentDeploymentId: servingId(x.targets?.production, x.lastAliasRequest),
        // P2: the repo exists only on git-linked projects (GitHub has org/repo; other providers may not). Function
        // regions fill the app page's "Function region" when Vercel returns them on the list.
        repo: x.link?.type && x.link.org && x.link.repo ? { type: x.link.type, org: x.link.org, repo: x.link.repo } : null,
        functionRegions: x.resourceConfig?.functionDefaultRegions ?? [],
        rootDirectory: cleanRootDir(x.rootDirectory),
        rootDirectoryUnsupported: unusableRootDir(x.rootDirectory),
        productionAliases: x.targets?.production?.alias ?? [],
      });
    }
    until = p.data.pagination?.next;
    if (!until) break;
  }
  return { ok: true, data: out };
}

const deploymentSchema = z.object({
  uid: z.string(),
  projectId: z.string(),
  state: z.string().nullish(),
  readyState: z.string().nullish(),
  target: z.string().nullish(),
  source: z.string().nullish(),
  url: z.string().nullish(),
  createdAt: z.number().nullish(),
  created: z.number().nullish(),
  buildingAt: z.number().nullish(),
  ready: z.number().nullish(),
  meta: z.record(z.string(), z.unknown()).nullish(),
});
const str = (v: unknown) => (typeof v === "string" && v.length ? v : null);
const date = (v: number | null | undefined) => (v ? new Date(v) : null);

function toDeployment(d: z.infer<typeof deploymentSchema>, id: string): VercelDeployment {
  const raw = d.readyState ?? d.state ?? "BUILDING";
  const m = d.meta ?? {};
  return {
    id, projectId: d.projectId, state: mapDeploymentState(raw), rawState: raw,
    target: d.target === "production" ? "production" : "preview",
    branch: str(m.githubCommitRef) ?? str(m.gitCommitRef),
    sha: str(m.githubCommitSha) ?? str(m.gitCommitSha),
    message: str(m.githubCommitMessage) ?? str(m.gitCommitMessage),
    source: d.source ?? null, url: d.url ?? null,
    createdAt: new Date(d.createdAt ?? d.created ?? 0), buildingAt: date(d.buildingAt), readyAt: date(d.ready),
  };
}

export async function listDeployments(token: string, team: VercelTeam, q: { since?: number; limit?: number }, opts: VercelOpts = {}): Promise<Result<VercelDeployment[]>> {
  const r = await get(`/v7/deployments?teamId=${encodeURIComponent(team.id)}&limit=${q.limit ?? 100}${q.since ? `&since=${q.since}` : ""}`, token, opts);
  if (!r.ok) return r;
  const p = z.object({ deployments: z.array(deploymentSchema) }).safeParse(r.data);
  if (!p.success) return format("the deployment list");
  return { ok: true, data: p.data.deployments.map((d) => toDeployment(d, d.uid)) };
}

// One deployment by id (GET /v13/deployments/{id}). The list above only reaches back as far as `since`, so this is how
// the project's current production deployment is read when it is older than that. The single-deployment answer names the
// id `id` (the list says `uid`); projectId is optional here because the caller already knows the project.
const oneDeploymentSchema = deploymentSchema.omit({ uid: true, projectId: true }).extend({ id: z.string(), projectId: z.string().nullish() });

export async function getDeployment(token: string, team: VercelTeam, id: string, opts: VercelOpts = {}): Promise<Result<VercelDeployment>> {
  const r = await get(`/v13/deployments/${encodeURIComponent(id)}?teamId=${encodeURIComponent(team.id)}`, token, opts);
  if (!r.ok) return r;
  const p = oneDeploymentSchema.safeParse(r.data);
  if (!p.success) return format("the deployment");
  return { ok: true, data: toDeployment({ ...p.data, uid: p.data.id, projectId: p.data.projectId ?? "" }, p.data.id) };
}

// ---------- Stage 6: the live reads an action makes first, then the four writes (plan A1) ----------

// The project's current production deployment (servingId), as in listProjects.
const oneProjectSchema = z.object({ name: z.string(), targets: z.object({ production: productionTargetSchema }).nullish(), lastAliasRequest: aliasRequestSchema });

export async function currentProduction(token: string, teamId: string, projectId: string, opts: VercelOpts = {}): Promise<Result<{ name: string; currentId: string | null }>> {
  const r = await get(`/v9/projects/${seg(projectId)}?${teamQ(teamId)}`, token, opts);
  if (!r.ok) return r;
  const p = oneProjectSchema.safeParse(r.data);
  if (!p.success) return format("the project");
  return { ok: true, data: { name: p.data.name, currentId: servingId(p.data.targets?.production, p.data.lastAliasRequest) } };
}

// v6 lists may leave projectId out; the caller asked for one project, so it is filled in.
const v6Schema = z.object({ deployments: z.array(deploymentSchema.extend({ projectId: z.string().nullish() })) });

async function projectDeployments(token: string, teamId: string, projectId: string, state: string, limit: number, opts: VercelOpts): Promise<Result<VercelDeployment[]>> {
  const q = `projectId=${seg(projectId)}&target=production&state=${state}&limit=${limit}&${teamQ(teamId)}`;
  const r = await get(`/v6/deployments?${q}`, token, opts);
  if (!r.ok) return r;
  const p = v6Schema.safeParse(r.data);
  if (!p.success) return format("the deployment list");
  return { ok: true, data: p.data.deployments.map((d) => toDeployment({ ...d, projectId: d.projectId ?? projectId }, d.uid)) };
}

// The 5 newest READY production deployments, newest first: the current one, the previous one (Hobby's only roll back
// target) and any staged ones newer than the current (what a roll back leaves).
export async function productionDeployments(token: string, teamId: string, projectId: string, opts: VercelOpts = {}): Promise<Result<VercelDeployment[]>> {
  return projectDeployments(token, teamId, projectId, "READY", 5, opts);
}

// A production build that is queued or running, or null. Redeploy refuses while there is one.
export async function runningProductionBuild(token: string, teamId: string, projectId: string, opts: VercelOpts = {}): Promise<Result<VercelDeployment | null>> {
  const r = await projectDeployments(token, teamId, projectId, "BUILDING,QUEUED,INITIALIZING", 1, opts);
  return r.ok ? { ok: true, data: r.data[0] ?? null } : r;
}

// Redeploy: the same commit as the current production deployment, built again with today's environment variables
// (no withLatestCommit), straight to production.
export async function redeploy(token: string, teamId: string, p: { projectId: string; name: string; deploymentId: string }, opts: VercelOpts = {}): Promise<WriteResult<{ id: string }>> {
  const r = await send("POST", `/v13/deployments?${teamQ(teamId)}`, token, { name: p.name, project: p.projectId, deploymentId: p.deploymentId, target: "production" }, opts);
  if (!r.ok) return r;
  // A 2xx means Vercel accepted it; an answer without an id still is a redeploy that happened, so it isn't a failure.
  const parsed = z.object({ id: z.string() }).safeParse(r.data);
  return { ok: true, data: { id: parsed.success ? parsed.data.id : "" } };
}

export async function rollback(token: string, teamId: string, projectId: string, deploymentId: string, opts: VercelOpts = {}): Promise<WriteResult<null>> {
  const r = await send("POST", `/v1/projects/${seg(projectId)}/rollback/${seg(deploymentId)}?${teamQ(teamId)}`, token, undefined, opts);
  return r.ok ? { ok: true, data: null } : r;
}

// Slice 2: with the empty JSON body the Vercel CLI sends and marks "required" (packages/cli/src/commands/promote).
export async function promote(token: string, teamId: string, projectId: string, deploymentId: string, opts: VercelOpts = {}): Promise<WriteResult<null>> {
  const r = await send("POST", `/v10/projects/${seg(projectId)}/promote/${seg(deploymentId)}?${teamQ(teamId)}`, token, {}, opts);
  return r.ok ? { ok: true, data: null } : r;
}

// Slice 2 (B1): promote a READY preview to production. Vercel can't move production traffic to a preview: it builds the
// preview's source again as a new production deployment with the production environment variables, which goes live
// when ready. This is exactly what `vercel promote <preview>` sends (same endpoint as Redeploy, plus meta.action).
export async function promotePreview(token: string, teamId: string, p: { projectId: string; name: string; deploymentId: string }, opts: VercelOpts = {}): Promise<WriteResult<{ id: string }>> {
  const r = await send("POST", `/v13/deployments?${teamQ(teamId)}`, token, { name: p.name, project: p.projectId, deploymentId: p.deploymentId, target: "production", meta: { action: "promote" } }, opts);
  if (!r.ok) return r;
  const parsed = z.object({ id: z.string() }).safeParse(r.data);
  return { ok: true, data: { id: parsed.success ? parsed.data.id : "" } };
}

export async function cancelDeployment(token: string, teamId: string, deploymentId: string, opts: VercelOpts = {}): Promise<WriteResult<null>> {
  const r = await send("PATCH", `/v12/deployments/${seg(deploymentId)}/cancel?${teamQ(teamId)}`, token, undefined, opts);
  return r.ok ? { ok: true, data: null } : r;
}

const domainsSchema = z.object({
  domains: z.array(z.object({
    name: z.string(), redirect: z.string().nullish(), verified: z.boolean().optional(), gitBranch: z.string().nullish(),
    customEnvironmentId: z.string().nullish().catch(null),
  })),
  pagination: z.object({ next: z.number().nullish() }).nullish(),
});

export type ProjectDomain = { name: string; redirect: string | null; verified: boolean; gitBranch: string | null; customEnvironmentId: string | null };

// Every page (100 a page, newest first, following pagination.next like listProjects) or a failure: a partial list
// would make a listed domain look gone (pastDomains) and move the primary domain (review T3 I1). A list that doesn't
// end within MAX_PAGES is a failure too, so callers keep what they stored.
export async function listProjectDomains(token: string, teamId: string, projectId: string, opts: VercelOpts = {}): Promise<Result<ProjectDomain[]>> {
  const out: ProjectDomain[] = [];
  let until: number | null | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await get(`/v9/projects/${encodeURIComponent(projectId)}/domains?teamId=${encodeURIComponent(teamId)}&limit=100${until ? `&until=${until}` : ""}`, token, opts);
    if (!r.ok) return r;
    const p = domainsSchema.safeParse(r.data);
    if (!p.success) return format("the domain list");
    for (const d of p.data.domains) out.push({ name: d.name, redirect: d.redirect ?? null, verified: d.verified !== false, gitBranch: d.gitBranch ?? null, customEnvironmentId: d.customEnvironmentId ?? null });
    until = p.data.pagination?.next;
    if (!until) return { ok: true, data: out };
  }
  return { ok: false, kind: "transient", error: `The project has more than ${MAX_PAGES * 100} domains; Watchbell kept the domains it had.` };
}

export async function productionHost(token: string, teamId: string, projectId: string, projectName: string, opts: VercelOpts = {}, productionAliases: string[] = []): Promise<Result<string>> {
  const r = await listProjectDomains(token, teamId, projectId, opts);
  return r.ok ? { ok: true, data: chooseProductionDomain(r.data, projectName, productionAliases) } : r;
}

const configSchema = z.object({
  misconfigured: z.boolean(),
  configuredBy: z.string().nullish(),
  recommendedIPv4: z.array(z.object({ value: z.array(z.string()) })).default([]),
});
export type DomainConfig = { misconfigured: boolean; configuredBy: string | null; recommendedIps: string[] };

// Vercel's verdict on a custom domain: misconfigured = not pointing at Vercel, or no certificate can be issued.
export async function domainConfig(token: string, teamId: string, domain: string, opts: VercelOpts = {}): Promise<Result<DomainConfig>> {
  const r = await get(`/v6/domains/${encodeURIComponent(domain)}/config?teamId=${encodeURIComponent(teamId)}`, token, opts);
  if (!r.ok) return r;
  const p = configSchema.safeParse(r.data);
  if (!p.success) return format("the domain configuration");
  return { ok: true, data: { misconfigured: p.data.misconfigured, configuredBy: p.data.configuredBy ?? null, recommendedIps: p.data.recommendedIPv4.flatMap((x) => x.value) } };
}

// Every scope on Vercel is a team (even the personal one). A token scoped to one team can't read the others;
// those come back 403 and are skipped rather than failing the whole sync.
export async function discoverVercel(token: string, opts: VercelOpts = {}): Promise<Result<{ apps: DiscoveredApp[]; skippedTeams: string[]; skippedTeamIds: string[] }>> {
  const teams = await listTeams(token, opts);
  if (!teams.ok) return teams;
  const apps: DiscoveredApp[] = [];
  const skippedTeams: string[] = [];
  const skippedTeamIds: string[] = [];
  for (const team of teams.data) {
    const projects = await listProjects(token, team, opts);
    if (!projects.ok) {
      // Only a 403 means "this token isn't allowed in this team". A 401 means the token itself is bad, so it fails the whole discovery.
      if (projects.status === 403) {
        skippedTeams.push(team.name);
        skippedTeamIds.push(team.id);
        continue;
      }
      return projects;
    }
    for (const p of projects.data) {
      apps.push({
        externalId: p.id, name: p.name,
        meta: { teamId: team.id, teamSlug: team.slug, teamName: team.name, framework: p.framework, productionBranch: p.productionBranch, createdAt: p.createdAt.toISOString(),
          repo: p.repo ? `${p.repo.org}/${p.repo.repo}` : null, repoType: p.repo?.type ?? null, functionRegions: p.functionRegions,
          rootDirectory: p.rootDirectory, ...(p.rootDirectoryUnsupported ? { rootDirectoryUnsupported: p.rootDirectoryUnsupported } : {}),
          ...(p.productionAliases.length ? { productionAliases: p.productionAliases } : {}) },
      });
    }
  }
  // An empty result here would make Sync mark every watched app as gone, so an unreadable token is a failure, not an empty list.
  if (skippedTeams.length === teams.data.length) {
    return { ok: false, kind: "auth", error: "This token can't read any of your Vercel teams. Create a token with access to them." };
  }
  return { ok: true, data: { apps, skippedTeams, skippedTeamIds } };
}

// Automatic security fixes (owner 16 Oct): the deployments Vercel built for one commit of a project (a PR's preview).
// Read only. Newest first.
export async function deploymentsForCommit(token: string, teamId: string, projectId: string, sha: string, opts: VercelOpts = {}): Promise<Result<VercelDeployment[]>> {
  if (!/^[0-9a-f]{40}$/.test(sha)) return format("the commit");
  const q = new URLSearchParams({ teamId, projectId, sha, limit: "10" });
  const r = await get(`/v6/deployments?${q}`, token, opts);
  if (!r.ok) return r;
  const p = z.object({ deployments: z.array(deploymentSchema) }).safeParse(r.data);
  if (!p.success) return format("the deployment list");
  return {
    ok: true,
    data: p.data.deployments.map((d) => toDeployment(d, d.uid)).filter((d) => d.projectId === projectId && (d.sha === null || d.sha === sha))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  };
}
