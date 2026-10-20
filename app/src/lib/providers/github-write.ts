import { z } from "zod";
import { isOwnBranch } from "@/lib/deps/bump";
import { isFullName, isGitRef, repoPath } from "./github";
import type { Failure, FetchOpts, Result } from "./http";

// Stage 9 slice 5: the ONLY GitHub writes in the console, with the separate "GitHub (PR write)" token (a fine-grained
// token with Contents and Pull requests: Read and write on chosen repositories). They run only from an approved office
// proposal ("Open package update PR"): read the default branch's head and package.json, create a new watchpost/deps-…
// branch, commit the edited package.json there, open a pull request. Every write names a watchpost/deps-… branch that
// isn't the default branch (isOwnBranch), checked here before any request is sent: nothing is ever pushed to the
// default branch.

const API = "https://api.github.com";
type Method = "GET" | "POST" | "PUT";

export const WRITE_SCOPE_ERROR = "The GitHub PR-write token can't do this (403). It needs Contents and Pull requests: Read and write on this repository.";

async function call(method: Method, path: string, token: string, body: unknown, opts: FetchOpts): Promise<{ ok: true; status: number; data: unknown } | Failure> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Watchbell",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs), cache: "no-store", redirect: "error",
    });
  } catch (e) {
    const late = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, kind: "transient", error: late ? `GitHub didn't answer within ${Math.round(timeoutMs / 1000)} seconds.` : "Couldn't reach GitHub." };
  }
  const text = await res.text().catch(() => "");
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.ok) return { ok: true, status: res.status, data };
  const status = res.status;
  if (status === 401) return { ok: false, kind: "auth", status, error: "GitHub rejected the PR-write token (401). It may have expired or been revoked." };
  if (status === 429 || (status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) return { ok: false, kind: "transient", status, error: "GitHub's rate limit is used up for now. Try again later." };
  if (status === 403) return { ok: false, kind: "scope", status, error: WRITE_SCOPE_ERROR };
  if (status === 404) return { ok: false, kind: "missing", status, error: "The PR-write token doesn't see this repository (404). Give it access to the repository." };
  if (status === 409 || status === 422) return { ok: false, kind: "format", status, error: `GitHub refused the change (${status}).` };
  return { ok: false, kind: "transient", status, error: `GitHub returned an error (${status}).` };
}

const fmt = (what: string): Failure => ({ ok: false, kind: "format", error: `GitHub answered ${what} in a format the console doesn't recognise.` });
const badRepo: Failure = { ok: false, kind: "format", error: "That isn't a repository or branch the console may write." };

export async function repoInfo(token: string, fullName: string, opts: FetchOpts = {}): Promise<Result<{ defaultBranch: string; canPush: boolean | null }>> {
  if (!isFullName(fullName)) return badRepo;
  const r = await call("GET", `/repos/${repoPath(fullName)}`, token, undefined, opts);
  if (!r.ok) return r;
  const p = z.object({ default_branch: z.string(), permissions: z.object({ push: z.boolean() }).partial().optional() }).safeParse(r.data);
  if (!p.success || !isGitRef(p.data.default_branch)) return fmt("the repository");
  return { ok: true, data: { defaultBranch: p.data.default_branch, canPush: p.data.permissions?.push ?? null } };
}

export async function branchHead(token: string, fullName: string, branch: string, opts: FetchOpts = {}): Promise<Result<string | null>> {
  if (!isFullName(fullName) || !isGitRef(branch)) return badRepo;
  const r = await call("GET", `/repos/${repoPath(fullName)}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, token, undefined, opts);
  if (!r.ok) return r.kind === "missing" ? { ok: true, data: null } : r;
  const p = z.object({ object: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }) }).safeParse(r.data);
  return p.success ? { ok: true, data: p.data.object.sha } : fmt("the branch");
}

// package.json at a commit: its text and blob SHA (the update needs the SHA).
export async function manifestAt(token: string, fullName: string, ref: string, opts: FetchOpts = {}): Promise<Result<{ text: string; sha: string } | null>> {
  if (!isFullName(fullName) || !isGitRef(ref)) return badRepo;
  const r = await call("GET", `/repos/${repoPath(fullName)}/contents/package.json?ref=${encodeURIComponent(ref)}`, token, undefined, opts);
  if (!r.ok) return r.kind === "missing" ? { ok: true, data: null } : r;
  const p = z.object({ sha: z.string(), encoding: z.literal("base64"), content: z.string() }).safeParse(r.data);
  if (!p.success) return fmt("package.json");
  return { ok: true, data: { sha: p.data.sha, text: Buffer.from(p.data.content.replace(/\s/g, ""), "base64").toString("utf8") } };
}

export async function createBranch(token: string, fullName: string, branch: string, fromSha: string, defaultBranch: string, opts: FetchOpts = {}): Promise<Result<true>> {
  if (!isFullName(fullName) || !isOwnBranch(branch, defaultBranch) || !/^[0-9a-f]{40}$/.test(fromSha)) return badRepo;
  const r = await call("POST", `/repos/${repoPath(fullName)}/git/refs`, token, { ref: `refs/heads/${branch}`, sha: fromSha }, opts);
  return r.ok ? { ok: true, data: true } : r;
}

export async function putManifest(token: string, fullName: string, branch: string, defaultBranch: string, text: string, blobSha: string, message: string, opts: FetchOpts = {}): Promise<Result<true>> {
  if (!isFullName(fullName) || !isOwnBranch(branch, defaultBranch)) return badRepo;
  const r = await call("PUT", `/repos/${repoPath(fullName)}/contents/package.json`, token, {
    message, content: Buffer.from(text, "utf8").toString("base64"), sha: blobSha, branch,
  }, opts);
  return r.ok ? { ok: true, data: true } : r;
}

const pullSchema = z.object({ number: z.number(), html_url: z.string().startsWith("https://github.com/") });

export async function openPull(token: string, fullName: string, owner: string, branch: string, defaultBranch: string, opts: FetchOpts = {}): Promise<Result<{ number: number; url: string } | null>> {
  if (!isFullName(fullName) || !isOwnBranch(branch, defaultBranch)) return badRepo;
  const q = new URLSearchParams({ state: "open", head: `${owner}:${branch}`, per_page: "1" });
  const r = await call("GET", `/repos/${repoPath(fullName)}/pulls?${q}`, token, undefined, opts);
  if (!r.ok) return r;
  const p = z.array(pullSchema).safeParse(r.data);
  if (!p.success) return fmt("the pull requests");
  const pr = p.data[0];
  return { ok: true, data: pr ? { number: pr.number, url: pr.html_url } : null };
}

export async function createPull(token: string, fullName: string, branch: string, defaultBranch: string, title: string, body: string, opts: FetchOpts = {}): Promise<Result<{ number: number; url: string }>> {
  if (!isFullName(fullName) || !isOwnBranch(branch, defaultBranch) || !isGitRef(defaultBranch)) return badRepo;
  const r = await call("POST", `/repos/${repoPath(fullName)}/pulls`, token, { title, head: branch, base: defaultBranch, body, maintainer_can_modify: true }, opts);
  if (!r.ok) return r;
  const p = pullSchema.safeParse(r.data);
  return p.success ? { ok: true, data: { number: p.data.number, url: p.data.html_url } } : fmt("the new pull request");
}

// ---- Automatic security fixes (owner 16 Oct): the merge watcher's reads and its one merge ----
// Reads use the same PR-write token (GitHub's table for fine-grained tokens): the PR list and the PR need "Pull requests:
// Read", the combined status "Commit statuses: Read"; check runs aren't readable with a fine-grained token, so a 403/404
// there falls back to the read token's Actions runs ("Actions: Read"). The merge needs "Contents: Read and write"; it is
// a squash merge of a watchpost/deps-… PR into its base branch, pinned to the head SHA the checks were read at (GitHub
// answers 409 when the head moved, 405 when it can't be merged).

export type OpenWatchpostPull = { number: number; branch: string; title: string; headSha: string; base: string };

const pullListSchema = z.array(z.object({
  number: z.number(), title: z.string(),
  head: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ ref: z.string() }),
}));

// Every open PR from a watchpost/deps-… branch of this repository (at most 100).
export async function openWatchpostPulls(token: string, fullName: string, opts: FetchOpts = {}): Promise<Result<OpenWatchpostPull[]>> {
  if (!isFullName(fullName)) return badRepo;
  const r = await call("GET", `/repos/${repoPath(fullName)}/pulls?state=open&per_page=100`, token, undefined, opts);
  if (!r.ok) return r;
  const p = pullListSchema.safeParse(r.data);
  if (!p.success) return fmt("the pull requests");
  return {
    ok: true,
    data: p.data.filter((x) => /^watchpost\/deps-[0-9a-f]{8}$/.test(x.head.ref) && x.head.repo?.full_name === fullName)
      .map((x) => ({ number: x.number, branch: x.head.ref, title: x.title, headSha: x.head.sha, base: x.base.ref })),
  };
}

export type PullState = { state: "open" | "closed"; merged: boolean; mergeable: boolean | null; headSha: string; branch: string; base: string };

export async function pullState(token: string, fullName: string, number: number, opts: FetchOpts = {}): Promise<Result<PullState>> {
  if (!isFullName(fullName) || !Number.isInteger(number) || number <= 0) return badRepo;
  const r = await call("GET", `/repos/${repoPath(fullName)}/pulls/${number}`, token, undefined, opts);
  if (!r.ok) return r;
  const p = z.object({
    state: z.enum(["open", "closed"]), merged: z.boolean().optional(), mergeable: z.boolean().nullable().optional(),
    head: z.object({ ref: z.string(), sha: z.string().regex(/^[0-9a-f]{40}$/) }), base: z.object({ ref: z.string() }),
  }).safeParse(r.data);
  if (!p.success) return fmt("the pull request");
  return { ok: true, data: { state: p.data.state, merged: p.data.merged === true, mergeable: p.data.mergeable ?? null, headSha: p.data.head.sha, branch: p.data.head.ref, base: p.data.base.ref } };
}

// Check runs and the combined status of a commit; null for one the token may not read (403 / 404).
export async function commitChecks(token: string, fullName: string, sha: string, opts: FetchOpts = {}): Promise<Result<{
  checkRuns: { status: string; conclusion: string | null }[] | null; combined: { state: string; total: number } | null;
}>> {
  if (!isFullName(fullName) || !/^[0-9a-f]{40}$/.test(sha)) return badRepo;
  const [runs, status] = await Promise.all([
    call("GET", `/repos/${repoPath(fullName)}/commits/${sha}/check-runs?per_page=100`, token, undefined, opts),
    call("GET", `/repos/${repoPath(fullName)}/commits/${sha}/status`, token, undefined, opts),
  ]);
  const unreadable = (r: typeof runs) => !r.ok && (r.kind === "scope" || r.kind === "missing");
  if (!runs.ok && !unreadable(runs)) return runs;
  if (!status.ok && !unreadable(status)) return status;
  const rp = runs.ok ? z.object({ check_runs: z.array(z.object({ status: z.string(), conclusion: z.string().nullable() })) }).safeParse(runs.data) : null;
  const sp = status.ok ? z.object({ state: z.string(), total_count: z.number() }).safeParse(status.data) : null;
  return {
    ok: true,
    data: {
      checkRuns: rp?.success ? rp.data.check_runs.map((c) => ({ status: c.status, conclusion: c.conclusion })) : null,
      combined: sp?.success ? { state: sp.data.state, total: sp.data.total_count } : null,
    },
  };
}

// Squash-merge a watchpost/deps-… PR, only while its head is still `sha`. 405 (not mergeable) and 409 (head moved) are
// refusals, never retried here.
export async function mergeWatchpostPull(token: string, fullName: string, number: number, branch: string, base: string, sha: string, title: string, opts: FetchOpts = {}): Promise<Result<{ sha: string }>> {
  if (!isFullName(fullName) || !isOwnBranch(branch, base) || !/^[0-9a-f]{40}$/.test(sha) || !Number.isInteger(number) || number <= 0) return badRepo;
  const r = await call("PUT", `/repos/${repoPath(fullName)}/pulls/${number}/merge`, token, {
    merge_method: "squash", sha, commit_title: `Watchbell: ${title.replace(/^Watch(?:bell|post):\s*/, "")}`.slice(0, 250),
  }, opts);
  if (!r.ok) {
    if (r.status === 405) return { ok: false, kind: "format", status: 405, error: "GitHub says the PR can't be merged now (405)." };
    if (r.status === 409) return { ok: false, kind: "format", status: 409, error: "The PR's head moved since the checks were read (409)." };
    return r;
  }
  const p = z.object({ merged: z.boolean(), sha: z.string() }).safeParse(r.data);
  return p.success && p.data.merged ? { ok: true, data: { sha: p.data.sha } } : fmt("the merge");
}

// Lockfile through GitHub Actions (owner 16 Oct): a repository_dispatch to the owner's actions repository. The
// PR-write token needs Contents: Read and write on that repository. 204 = accepted.
export async function dispatchLockfile(token: string, actionsRepo: string, payload: { repo: string; branch: string; lockfile: string; pr: number }, opts: FetchOpts = {}): Promise<Result<true>> {
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(actionsRepo)) return badRepo;
  const r = await call("POST", `/repos/${actionsRepo}/dispatches`, token, { event_type: "watchpost-lockfile", client_payload: payload }, opts);
  return r.ok ? { ok: true, data: true } : r;
}
