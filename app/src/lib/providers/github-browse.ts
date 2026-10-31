import { z } from "zod";
import { countFromLink } from "@/lib/github/browse";
import { gh, isFullName, isGitRef, MAX_REPO_PAGES, repoPath } from "./github";
import type { Failure, FetchOpts, Result } from "./http";

// GitHub → Repositories (owner 16 Oct): the repository browser's reads with the read-only token. Every call is a GET
// (gh() never sends anything else); answers are Zod-validated and only display fields are kept (never an email).

const fmt = (what: string): Failure => ({ ok: false, kind: "format", error: `GitHub answered ${what} in a format the console doesn't recognise.` });
const bad: Failure = { ok: false, kind: "format", error: "That isn't a repository name or ref." };
const ghUrl = (v: string | null | undefined): string | null => (v && v.startsWith("https://github.com/") ? v : null);

// Each repository's main language, for the list (the stored rows don't keep it). Same listing as the sync.
export async function repoLanguages(token: string, opts: FetchOpts = {}): Promise<Result<Map<string, string>>> {
  const out = new Map<string, string>();
  const schema = z.array(z.object({ full_name: z.string(), language: z.string().nullish() }));
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const r = await gh(`/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`, token, opts);
    if (!r.ok) return r;
    const p = schema.safeParse(r.data);
    if (!p.success) return fmt("the repository list");
    for (const x of p.data) if (x.language) out.set(x.full_name.toLowerCase(), x.language.slice(0, 40));
    if (p.data.length < 100) break;
  }
  return { ok: true, data: out };
}

export type RepoInfo = { description: string | null; language: string | null; openIssuesAndPulls: number; openPulls: number; htmlUrl: string | null };

// The header's facts: language, description, open issues and pull requests (GitHub counts both as issues; the open
// pull requests are counted with a one-row page and its Link header).
export async function repoInfo(token: string, fullName: string, opts: FetchOpts = {}): Promise<Result<RepoInfo>> {
  if (!isFullName(fullName)) return bad;
  const [r, pulls] = await Promise.all([
    gh(`/repos/${repoPath(fullName)}`, token, opts),
    gh(`/repos/${repoPath(fullName)}/pulls?state=open&per_page=1`, token, opts),
  ]);
  if (!r.ok) return r;
  const p = z.object({ description: z.string().nullish(), language: z.string().nullish(), open_issues_count: z.number().nullish(), html_url: z.string().nullish() }).safeParse(r.data);
  if (!p.success) return fmt("the repository");
  const openPulls = pulls.ok && Array.isArray(pulls.data) ? countFromLink(pulls.headers.get("link"), pulls.data.length) : 0;
  return {
    ok: true,
    data: {
      description: p.data.description?.slice(0, 300) ?? null, language: p.data.language ?? null, openIssuesAndPulls: p.data.open_issues_count ?? 0, openPulls,
      htmlUrl: ghUrl(p.data.html_url),
    },
  };
}

export type Readme = { path: string; text: string | null; size: number };

// The README GitHub shows for the ref (its path, for relative links), or null when there is none. `text` is null when
// it is over `maxBytes` or isn't text.
export async function readme(token: string, fullName: string, ref: string, maxBytes: number, opts: FetchOpts = {}): Promise<Result<Readme | null>> {
  if (!isFullName(fullName) || !isGitRef(ref)) return bad;
  const r = await gh(`/repos/${repoPath(fullName)}/readme?ref=${encodeURIComponent(ref)}`, token, opts);
  if (!r.ok) return r.kind === "missing" ? { ok: true, data: null } : r;
  const p = z.object({ path: z.string(), size: z.number(), content: z.string().nullish(), encoding: z.string().nullish() }).safeParse(r.data);
  if (!p.success) return fmt("the README");
  if (p.data.size > maxBytes || p.data.encoding !== "base64" || !p.data.content) return { ok: true, data: { path: p.data.path, text: null, size: p.data.size } };
  const text = Buffer.from(p.data.content, "base64").toString("utf8");
  if (text.includes("\u0000")) return { ok: true, data: { path: p.data.path, text: null, size: p.data.size } };
  return { ok: true, data: { path: p.data.path, text, size: p.data.size } };
}

export type Commit = { sha: string; title: string; author: string | null; at: string | null; url: string | null };

// The newest commits on a ref (the title line only; the author's GitHub login, else their name; never an email).
export async function commits(token: string, fullName: string, ref: string, perPage = 20, opts: FetchOpts = {}): Promise<Result<Commit[]>> {
  if (!isFullName(fullName) || !isGitRef(ref)) return bad;
  const r = await gh(`/repos/${repoPath(fullName)}/commits?sha=${encodeURIComponent(ref)}&per_page=${perPage}`, token, opts);
  if (!r.ok) return r;
  const p = z.array(commitSchema).safeParse(r.data);
  if (!p.success) return fmt("the commits");
  return { ok: true, data: p.data.map(toCommit) };
}

const commitSchema = z.object({
  sha: z.string(), html_url: z.string().nullish(), author: z.object({ login: z.string() }).nullish(),
  commit: z.object({ message: z.string(), author: z.object({ name: z.string().nullish(), date: z.string().nullish() }).nullish() }),
});
const toCommit = (c: z.infer<typeof commitSchema>): Commit => ({
  sha: c.sha, title: c.commit.message.split("\n")[0].slice(0, 200), author: (c.author?.login ?? c.commit.author?.name ?? null)?.slice(0, 80) ?? null,
  at: c.commit.author?.date ?? null, url: ghUrl(c.html_url),
});
const isSha = (v: string) => /^[0-9a-f]{7,40}$/.test(v);

// Watchbell 1.3 What changed: the commits from base (excluded) to head, newest first, and GitHub's total (it lists at
// most 250). Same fields as commits(); never an email. Up to 10 s, like the env read: a long comparison can be slow.
export async function compareCommits(token: string, fullName: string, base: string, head: string, opts: FetchOpts = {}): Promise<Result<{ commits: Commit[]; total: number }>> {
  if (!isFullName(fullName) || !isSha(base) || !isSha(head)) return bad;
  const r = await gh(`/repos/${repoPath(fullName)}/compare/${base}...${head}`, token, { timeoutMs: 10_000, ...opts });
  if (!r.ok) return r;
  const p = z.object({ total_commits: z.number(), commits: z.array(commitSchema) }).safeParse(r.data);
  if (!p.success) return fmt("the comparison");
  return { ok: true, data: { commits: p.data.commits.map(toCommit).reverse(), total: p.data.total_commits } };
}

export type Branch = { name: string; sha: string; protected: boolean };

export async function branches(token: string, fullName: string, opts: FetchOpts = {}): Promise<Result<{ branches: Branch[]; more: boolean }>> {
  if (!isFullName(fullName)) return bad;
  const r = await gh(`/repos/${repoPath(fullName)}/branches?per_page=100`, token, opts);
  if (!r.ok) return r;
  const p = z.array(z.object({ name: z.string(), protected: z.boolean().nullish(), commit: z.object({ sha: z.string() }) })).safeParse(r.data);
  if (!p.success) return fmt("the branches");
  return { ok: true, data: { branches: p.data.map((b) => ({ name: b.name, sha: b.commit.sha, protected: b.protected ?? false })), more: /rel="next"/.test(r.headers.get("link") ?? "") } };
}

export type Run = {
  id: number; name: string | null; title: string | null; status: string; conclusion: string | null; branch: string | null; event: string | null;
  sha: string | null; runNumber: number | null; at: string | null; url: string | null;
};

export async function runs(token: string, fullName: string, perPage = 10, opts: FetchOpts = {}): Promise<Result<Run[]>> {
  if (!isFullName(fullName)) return bad;
  const r = await gh(`/repos/${repoPath(fullName)}/actions/runs?per_page=${perPage}`, token, opts);
  if (!r.ok) return r;
  const p = z.object({
    workflow_runs: z.array(z.object({
      id: z.number(), name: z.string().nullish(), display_title: z.string().nullish(), status: z.string().nullish(), conclusion: z.string().nullish(),
      head_branch: z.string().nullish(), event: z.string().nullish(), head_sha: z.string().nullish(), run_number: z.number().nullish(),
      updated_at: z.string().nullish(), created_at: z.string().nullish(), html_url: z.string().nullish(),
    })),
  }).safeParse(r.data);
  if (!p.success) return fmt("the Actions runs");
  return {
    ok: true,
    data: p.data.workflow_runs.map((x) => ({
      id: x.id, name: x.name ?? null, title: x.display_title?.slice(0, 200) ?? null, status: x.status ?? "unknown", conclusion: x.conclusion ?? null,
      branch: x.head_branch ?? null, event: x.event ?? null, sha: x.head_sha ?? null, runNumber: x.run_number ?? null, at: x.updated_at ?? x.created_at ?? null,
      url: ghUrl(x.html_url),
    })),
  };
}
