import { z } from "zod";
import type { RepoRun } from "@/db/schema";
import type { Failure, FetchOpts, Result } from "./http";

// Stage 7, GitHub connection (owner's TODO, 13 Oct): a read-only fine-grained token (Metadata, Contents and Actions
// read). Every call is a GET; the adapter never writes. Plain fetch, Zod-validated, 5 s per call.

const API = "https://api.github.com";
export const MAX_REPO_PAGES = 3; // 300 repositories
export const PACKAGE_MAX_BYTES = 256 * 1024;

export type GhRepo = {
  id: string; owner: string; name: string; fullName: string; defaultBranch: string | null; private: boolean; archived: boolean;
  htmlUrl: string | null; pushedAt: Date | null;
};

export const isFullName = (v: string): boolean => /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(v) && !v.includes("..");
export const repoPath = (fullName: string) => fullName.split("/").map(encodeURIComponent).join("/");

type Ok = { ok: true; data: unknown; text: string; headers: Headers };

export async function gh(path: string, token: string, opts: FetchOpts, accept = "application/vnd.github+json"): Promise<Ok | Failure> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Watchbell" },
      signal: AbortSignal.timeout(timeoutMs), cache: "no-store",
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, kind: "transient", error: timedOut ? `GitHub didn't answer within ${Math.round(timeoutMs / 1000)} seconds.` : "Couldn't reach GitHub." };
  }
  const text = await res.text().catch(() => "");
  if (res.ok) {
    let data: unknown = null;
    if (accept.endsWith("+json") && !accept.includes(".raw")) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    return { ok: true, data, text, headers: res.headers };
  }
  const status = res.status;
  if (status === 401) return { ok: false, kind: "auth", status, error: "GitHub rejected this token (401). It may have expired or been revoked." };
  if ((status === 403 || status === 429) && (res.headers.get("x-ratelimit-remaining") === "0" || status === 429)) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const retryAfterS = Number.isFinite(reset) && reset > 0 ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : 60;
    return { ok: false, kind: "transient", status, retryAfterS, error: "GitHub's rate limit is used up for now. The next run tries again." };
  }
  if (status === 403) return { ok: false, kind: "scope", status, error: "This token can't read that (403). It needs Metadata, Contents and Actions read on the repository." };
  if (status === 404) return { ok: false, kind: "missing", status, error: "GitHub doesn't show this to the token (404)." };
  return { ok: false, kind: "transient", status, error: `GitHub returned an error (${status}).` };
}

// "2026-11-14 10:00:00 +0700" or "2026-11-14 03:00:00 UTC" (GitHub's header on tokens that expire). Null when absent.
export function tokenExpiryFrom(headers: Headers): Date | null {
  const raw = headers.get("github-authentication-token-expiration")?.trim();
  if (!raw) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/.exec(raw);
  if (!m) return null;
  const zone = !m[3] || m[3] === "UTC" || m[3] === "Z" ? "Z" : m[3].includes(":") ? m[3] : `${m[3].slice(0, 3)}:${m[3].slice(3)}`;
  const d = new Date(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const repoSchema = z.object({
  id: z.number(), name: z.string(), full_name: z.string(), owner: z.object({ login: z.string() }),
  default_branch: z.string().nullish(), private: z.boolean(), archived: z.boolean().optional(), html_url: z.string().nullish(), pushed_at: z.string().nullish(),
});
const fmt = (what: string): Failure => ({ ok: false, kind: "format", error: `GitHub answered ${what} in a format the console doesn't recognise.` });

export async function githubUser(token: string, opts: FetchOpts = {}): Promise<Result<{ expiresAt: Date | null }>> {
  const r = await gh("/user", token, opts);
  if (!r.ok) return r;
  return z.object({ login: z.string() }).safeParse(r.data).success ? { ok: true, data: { expiresAt: tokenExpiryFrom(r.headers) } } : fmt("the token check");
}

// Every repository the token can see, newest push first, at most MAX_REPO_PAGES pages. A failure is a failure, never
// an empty list (an empty list would mark every repository gone).
export async function listRepos(token: string, opts: FetchOpts = {}): Promise<Result<{ repos: GhRepo[]; truncated: boolean }>> {
  const repos: GhRepo[] = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const r = await gh(`/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`, token, opts);
    if (!r.ok) return r;
    const p = z.array(repoSchema).safeParse(r.data);
    if (!p.success) return fmt("the repository list");
    for (const x of p.data) {
      if (!isFullName(x.full_name)) continue;
      const pushed = x.pushed_at ? new Date(x.pushed_at) : null;
      repos.push({
        id: String(x.id), owner: x.owner.login, name: x.name, fullName: x.full_name, defaultBranch: x.default_branch ?? null, private: x.private,
        archived: x.archived ?? false, htmlUrl: x.html_url ?? null, pushedAt: pushed && !Number.isNaN(pushed.getTime()) ? pushed : null,
      });
    }
    if (p.data.length < 100) return { ok: true, data: { repos, truncated: false } };
  }
  return { ok: true, data: { repos, truncated: true } };
}

// The `name` in the repository's root package.json (Contents read), or null when there is none or it can't be read as
// one. Only the name is kept; the file itself is never stored.
export async function packageName(token: string, fullName: string, opts: FetchOpts = {}): Promise<Result<string | null>> {
  if (!isFullName(fullName)) return { ok: true, data: null };
  const r = await gh(`/repos/${repoPath(fullName)}/contents/package.json`, token, opts, "application/vnd.github.raw+json");
  if (!r.ok) return r.kind === "missing" ? { ok: true, data: null } : r;
  if (r.text.length > PACKAGE_MAX_BYTES) return { ok: true, data: null };
  try {
    const name = (JSON.parse(r.text) as { name?: unknown }).name;
    return { ok: true, data: typeof name === "string" && name.trim() && name.length <= 214 ? name.trim() : null };
  } catch {
    return { ok: true, data: null };
  }
}

const runsSchema = z.object({
  total_count: z.number(),
  workflow_runs: z.array(z.object({
    status: z.string().nullish(), conclusion: z.string().nullish(), name: z.string().nullish(), display_title: z.string().nullish(),
    head_branch: z.string().nullish(), head_sha: z.string().nullish(), html_url: z.string().nullish(), run_number: z.number().nullish(),
    updated_at: z.string().nullish(), created_at: z.string().nullish(),
  })),
});

// The latest GitHub Actions run on a branch (Actions read). { none: true } when the repository has no run there.
export async function latestRun(token: string, fullName: string, branch: string | null, opts: FetchOpts = {}): Promise<Result<RepoRun>> {
  if (!isFullName(fullName)) return { ok: false, kind: "format", error: "That isn't a repository name." };
  const q = new URLSearchParams({ per_page: "1", exclude_pull_requests: "true", ...(branch ? { branch } : {}) });
  const r = await gh(`/repos/${repoPath(fullName)}/actions/runs?${q}`, token, opts);
  if (!r.ok) return r;
  const p = runsSchema.safeParse(r.data);
  if (!p.success) return fmt("the Actions runs");
  const run = p.data.workflow_runs[0];
  if (!run) return { ok: true, data: { none: true } };
  return {
    ok: true,
    data: {
      status: run.status ?? "unknown", conclusion: run.conclusion ?? null, name: run.name ?? run.display_title ?? null, branch: run.head_branch ?? null,
      sha: run.head_sha ?? null, url: run.html_url?.startsWith("https://github.com/") ? run.html_url : null, at: run.updated_at ?? run.created_at ?? null,
      runNumber: run.run_number ?? null,
    },
  };
}

// Stage 9 slice 3 (the office's Dev officer): the repository's file list at a ref and one file's text. GET only, like
// everything here. A ref is a commit SHA or a branch name; anything else is refused before a URL is built.
export const isGitRef = (v: string): boolean => /^[A-Za-z0-9._\/-]{1,200}$/.test(v) && !v.includes("..") && !v.startsWith("/") && !v.endsWith("/");
export const TREE_MAX_ENTRIES = 20_000;

export type TreeEntry = { path: string; size: number };

const treeSchema = z.object({
  sha: z.string().optional(), truncated: z.boolean().optional(),
  tree: z.array(z.object({ path: z.string(), type: z.string(), size: z.number().optional() })),
});

// The recursive git tree (blobs only): one call. GitHub cuts very large trees (`truncated`); what came back is kept.
export async function repoTree(token: string, fullName: string, ref: string, opts: FetchOpts = {}): Promise<Result<{ entries: TreeEntry[]; truncated: boolean }>> {
  if (!isFullName(fullName) || !isGitRef(ref)) return { ok: false, kind: "format", error: "That isn't a repository name or ref." };
  const r = await gh(`/repos/${repoPath(fullName)}/git/trees/${encodeURIComponent(ref)}?recursive=1`, token, { timeoutMs: 8000, ...opts });
  if (!r.ok) return r;
  const p = treeSchema.safeParse(r.data);
  if (!p.success) return fmt("the file list");
  const entries = p.data.tree.filter((e) => e.type === "blob").slice(0, TREE_MAX_ENTRIES).map((e) => ({ path: e.path, size: e.size ?? 0 }));
  return { ok: true, data: { entries, truncated: p.data.truncated === true || p.data.tree.length > TREE_MAX_ENTRIES } };
}

// One file's text at a ref (Contents read, raw), or null when it is larger than `maxBytes` or doesn't read as text.
export async function fileText(token: string, fullName: string, path: string, ref: string, maxBytes: number, opts: FetchOpts = {}): Promise<Result<string | null>> {
  if (!isFullName(fullName) || !isGitRef(ref) || !path || path.split("/").includes("..") || path.startsWith("/")) return { ok: false, kind: "format", error: "That isn't a file in a repository." };
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const r = await gh(`/repos/${repoPath(fullName)}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, token, opts, "application/vnd.github.raw+json");
  if (!r.ok) return r;
  if (Buffer.byteLength(r.text, "utf8") > maxBytes) return { ok: true, data: null };
  // A NUL character (or a run of replacement characters) means a binary file.
  if (r.text.includes("\u0000") || (r.text.match(/�/g)?.length ?? 0) > 8) return { ok: true, data: null };
  return { ok: true, data: r.text };
}

// The Actions runs of one commit (Actions read on the read-only token): the PR watcher's stand-in when the PR-write
// token can't read check runs or commit statuses.
export async function runsForCommit(token: string, fullName: string, sha: string, opts: FetchOpts = {}): Promise<Result<{ status: string; conclusion: string | null }[]>> {
  if (!isFullName(fullName) || !/^[0-9a-f]{40}$/.test(sha)) return { ok: false, kind: "format", error: "That isn't a repository or commit." };
  const r = await gh(`/repos/${repoPath(fullName)}/actions/runs?head_sha=${sha}&per_page=50`, token, opts);
  if (!r.ok) return r;
  const p = z.object({ workflow_runs: z.array(z.object({ status: z.string().nullish(), conclusion: z.string().nullish() })) }).safeParse(r.data);
  if (!p.success) return fmt("the Actions runs");
  return { ok: true, data: p.data.workflow_runs.map((x) => ({ status: x.status ?? "queued", conclusion: x.conclusion ?? null })) };
}
