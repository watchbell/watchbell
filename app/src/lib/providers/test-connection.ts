import { z } from "zod";
import { DEPS_COPY } from "@/lib/copy/edition";
import { authUserCount, firestoreOps, firestorePing, listFirebaseProjects, withOwnProject } from "./firebase";
import { googleAccessToken, parseServiceAccount } from "./google";
import type { Failure } from "./http";
import { type Provider, PROVIDER_INFO } from "./info";
import { githubUser, listRepos } from "./github";
import { listD1 } from "./cloudflare-d1";
import { discoverNeon } from "./neon";
import { BAD_SERVICE_ACCOUNT } from "./normalize";
import { SCOPE_EFFECT, type SupabaseProject, supabaseScopeCheck } from "./supabase";
import { discoverTurso, tursoOrgUsage } from "./turso";
import { listUpstashRedis, parseUpstashCred, upstashStats } from "./upstash";

// auth: the provider rejected the credential. transient: timeout, network, rate limit or provider outage, so the
// credential may be fine. format: the provider answered with something the console can't read.
export type FailureKind = "auth" | "transient" | "format";
export type TestResult = { ok: true; summary: string; details: string[]; scopeNote?: string } | { ok: false; error: string; kind: FailureKind };
type Opts = { fetch?: typeof fetch; timeoutMs?: number };

const ALL_GOOD = ["Every permission it needs is there"];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function call(provider: Provider, url: string, token: string, opts: Opts): Promise<{ ok: true; body: unknown } | { ok: false; error: string; kind: FailureKind }> {
  const name = PROVIDER_INFO[provider].name;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      cache: "no-store",
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, kind: "transient", error: timedOut ? `${name} didn't answer within 5 seconds. Try again.` : `Couldn't reach ${name}. Check your connection and try again.` };
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 403 && provider === "supabase") {
    const missing = z.object({ missing_permissions: z.array(z.string()) }).safeParse(body);
    if (missing.success && missing.data.missing_permissions.length) {
      const list = missing.data.missing_permissions;
      return { ok: false, kind: "auth", error: `Missing permission${list.length > 1 ? "s" : ""}: ${list.join(", ")}. Create a new token that includes ${list.length > 1 ? "them" : "it"}.` };
    }
  }
  if (res.status === 401 || res.status === 403) return { ok: false, kind: "auth", error: `${name} rejected this credential (${res.status}). Check that you copied all of it.` };
  if (res.status === 429) return { ok: false, kind: "transient", error: `${name} says there were too many requests. Try again in a minute.` };
  if (!res.ok) return { ok: false, kind: "transient", error: `${name} returned an error (${res.status}). Try again in a minute.` };
  return { ok: true, body };
}

const unexpected = (provider: Provider): TestResult => ({ ok: false, kind: "format", error: `${PROVIDER_INFO[provider].name} answered in a format the console doesn't recognise.` });

// The adapters' failures, in the dialog's wording (same sentences as call() above).
function fromFailure(provider: Provider, f: Failure): TestResult {
  const name = PROVIDER_INFO[provider].name;
  // GitHub's adapter already words its failures for the owner (lib/providers/github.ts).
  if (provider === "github" || provider === "github_write") return { ok: false, kind: f.kind === "auth" || f.kind === "scope" ? "auth" : f.kind === "format" ? "format" : "transient", error: f.error };
  if (f.kind === "scope" && f.missing?.length) return { ok: false, kind: "auth", error: `Missing permission${f.missing.length > 1 ? "s" : ""}: ${f.missing.join(", ")}. Create a new token that includes ${f.missing.length > 1 ? "them" : "it"}.` };
  if (f.kind === "auth" || f.kind === "scope") return { ok: false, kind: "auth", error: provider === "firebase" ? f.error : `${name} rejected this credential (${f.status ?? 401}). Check that you copied all of it.` };
  if (f.kind === "format") return { ok: false, kind: "format", error: `${name} answered in a format the console doesn't recognise.` };
  return { ok: false, kind: "transient", error: `${f.error} Try again in a minute.` };
}

const PERM_WORD: Record<string, string> = { project_admin_read: "service health", analytics_usage_read: "API traffic", organization_admin_read: "organization plan" };

export async function testConnection(provider: Provider, credential: string, opts: Opts = {}): Promise<TestResult> {
  switch (provider) {
    case "vercel": {
      const r = await call(provider, "https://api.vercel.com/v10/projects?limit=100", credential, opts);
      if (!r.ok) return r;
      const p = z.object({ projects: z.array(z.object({ name: z.string() })) }).safeParse(r.body);
      return p.success ? { ok: true, summary: `Found ${plural(p.data.projects.length, "project")}`, details: ALL_GOOD } : unexpected(provider);
    }
    case "supabase": {
      const r = await call(provider, "https://api.supabase.com/v1/projects", credential, opts);
      if (!r.ok) return r;
      const p = z.array(z.object({
        ref: z.string(), name: z.string(), status: z.string(), organization_slug: z.string().optional(), region: z.string().optional(), created_at: z.string().optional(),
      })).safeParse(r.body);
      if (!p.success) return unexpected(provider);
      const active = p.data.filter((x) => x.status.startsWith("ACTIVE")).length;
      const paused = p.data.filter((x) => x.status === "INACTIVE").length;
      const projects: SupabaseProject[] = p.data.map((x) => ({ ref: x.ref, name: x.name, orgSlug: x.organization_slug ?? "", region: x.region ?? "", createdAt: x.created_at ?? "", status: x.status, pgVersion: null }));
      const scopes = await supabaseScopeCheck(credential, projects, opts);
      const reads = ["projects", ...scopes.used.filter((u) => u !== "projects_read").map((u) => PERM_WORD[u] ?? u)];
      return {
        ok: true,
        summary: `Found ${plural(p.data.length, "project")} (${active} active, ${paused} paused)`,
        details: [...(scopes.missing.length ? scopes.missing.map((m) => `Missing ${m}: ${SCOPE_EFFECT[m] ?? "some columns stay empty"}`) : ALL_GOOD), ...scopes.notes],
        scopeNote: `Reads ${reads.join(", ")}${scopes.missing.length ? ` · missing ${scopes.missing.join(", ")}` : ""} · database size checked daily`,
      };
    }
    case "neon": {
      const r = await discoverNeon(credential, opts);
      return r.ok ? { ok: true, summary: `Found ${plural(r.data.length, "project")}`, details: ALL_GOOD } : fromFailure(provider, r);
    }
    case "cloudflare": {
      const r = await call(provider, "https://api.cloudflare.com/client/v4/zones?per_page=50", credential, opts);
      if (!r.ok) return r;
      const p = z.object({ success: z.literal(true), result: z.array(z.object({ name: z.string(), account: z.object({ id: z.string() }).nullish() })) }).safeParse(r.body);
      if (!p.success) return unexpected(provider);
      // Stage 8: one D1 list call on the zones' account says whether "D1 Read" is on the token (optional).
      const account = p.data.result.find((z) => z.account?.id)?.account?.id;
      const d1 = account ? await listD1(credential, account, opts) : null;
      const d1Line = !d1 ? "D1 not checked (no zone to find the account)" : d1.ok ? `D1 read ✓ (${plural(d1.data.length, "database")})` : d1.kind === "scope" || d1.kind === "auth" ? "No D1 read: add Account → D1 → Read to watch D1 databases (optional)" : "D1 couldn't be checked right now";
      return {
        ok: true, summary: `Found ${plural(p.data.result.length, "zone")}`, details: [...ALL_GOOD, d1Line],
        scopeNote: `Zone, DNS, SSL and Certificates read${d1?.ok ? " · D1 read" : ""}`,
      };
    }
    case "firebase": {
      const sa = parseServiceAccount(credential);
      if (!sa) return { ok: false, kind: "format", error: BAD_SERVICE_ACCOUNT };
      const token = await googleAccessToken(sa, opts);
      if (!token.ok) return fromFailure(provider, token);
      const listed = await listFirebaseProjects(token.data, opts);
      const found = withOwnProject(sa, listed);
      if (!found.ok) return fromFailure(provider, found);
      const now = new Date();
      const [ping, users, ops] = await Promise.all([
        firestorePing(token.data, sa.project_id, opts),
        authUserCount(token.data, sa.project_id, opts),
        firestoreOps(token.data, sa.project_id, new Date(now.getTime() - 3_600_000), now, opts),
      ]);
      const mark = (ok: boolean) => (ok ? "✓" : "✗ (role missing)");
      const roles = [listed.ok ? "firebase.viewer" : null, ping.ok ? "datastore.viewer" : null, users.ok ? "firebaseauth.viewer" : null, ops.ok ? "monitoring.viewer" : null].filter(Boolean);
      return {
        ok: true,
        summary: `Found ${plural(found.data.length, "Firebase project")}`,
        details: [
          `Firestore health read ${mark(ping.ok)} · Auth user count ${mark(users.ok)}`,
          ops.ok ? "Cloud Monitoring: reads, writes, and deletes today can be read ✓" : `Cloud Monitoring can't be read (${ops.reason ?? ops.kind}): reads, writes and deletes today stay empty`,
        ],
        scopeNote: `${roles.join(", ")}${ops.ok ? "" : " · no Cloud Monitoring"}`,
      };
    }
    case "turso": {
      // Stage 8: the organizations and their databases, then one usage read (the free limits are per organization).
      const r = await discoverTurso(credential, opts);
      if (!r.ok) return fromFailure(provider, r);
      const org = r.data[0]?.org;
      const usage = org ? await tursoOrgUsage(credential, org, opts) : null;
      return {
        ok: true, summary: `Found ${plural(r.data.length, "database")}`,
        details: [usage === null ? "No database yet: usage is read once there is one" : usage.ok ? "Usage read ✓ (rows read and written, storage)" : `Usage can't be read (${usage.kind}): the usage columns stay empty`],
        scopeNote: `Databases${usage?.ok ? " and usage" : ""} · no read-only option`,
      };
    }
    case "upstash": {
      const cred = parseUpstashCred(credential);
      if (!cred) return { ok: false, kind: "format", error: "Paste your Upstash email and the API key as email:API_KEY." };
      const r = await listUpstashRedis(cred, opts);
      if (!r.ok) return fromFailure(provider, r);
      const stats = r.data[0] ? await upstashStats(cred, r.data[0].id, opts) : null;
      return {
        ok: true, summary: `Found ${plural(r.data.length, "Redis database")}`,
        details: [stats === null ? "No database yet: stats are read once there is one" : stats.ok ? "Stats read ✓ (commands, data size, bandwidth)" : `Stats can't be read (${stats.kind})`],
        scopeNote: "Redis databases and stats",
      };
    }
    case "github": {
      // Stage 7: the token works (GET /user), then the repositories it can see (Metadata read). Contents and Actions
      // read can't be checked without a repository, so the first Sync shows them per repository.
      const user = await githubUser(credential, opts);
      if (!user.ok) return fromFailure(provider, user);
      const repos = await listRepos(credential, opts);
      if (!repos.ok) return fromFailure(provider, repos);
      const n = repos.data.repos.length;
      return {
        ok: true,
        summary: `Found ${repos.data.truncated ? `${n}+` : n} repositor${n === 1 ? "y" : "ies"}`,
        details: [n ? "Metadata read ✓" : "No repositories are shared with this token yet: give it access to your apps' repositories", "Contents and Actions read are checked per repository on the first Sync"],
        scopeNote: "Metadata, Contents and Actions read",
      };
    }
    case "github_write": {
      // Stage 9 slice 5: the token works and sees repositories. Write access can't be tested without writing, so the
      // first approved PR proves it (Connections shows the outcome under Access).
      const user = await githubUser(credential, opts);
      if (!user.ok) return fromFailure(provider, user);
      const repos = await listRepos(credential, opts);
      if (!repos.ok) return fromFailure(provider, repos);
      const n = repos.data.repos.length;
      return {
        ok: true,
        summary: `Sees ${repos.data.truncated ? `${n}+` : n} repositor${n === 1 ? "y" : "ies"}`,
        details: [n ? "Metadata read ✓" : "No repositories are shared with this token yet: choose the repositories you want update PRs for", DEPS_COPY.githubWriteDetail],
        scopeNote: "Contents and Pull requests read and write",
      };
    }
  }
}
