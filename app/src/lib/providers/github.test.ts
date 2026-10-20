import { describe, expect, it } from "vitest";
import { githubUser, isFullName, latestRun, listRepos, packageName, tokenExpiryFrom } from "./github";

type Seen = { url: string; method: string; headers: Record<string, string> };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function fake(...answers: Response[]) {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: String(init.method ?? "GET"), headers: init.headers as Record<string, string> });
    return answers.shift() ?? json({ message: "unexpected" }, 500);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

const repo = (n: number, over: Record<string, unknown> = {}) => ({
  id: n, name: `app-${n}`, full_name: `acme/app-${n}`, owner: { login: "acme" }, default_branch: "main", private: true, archived: false,
  html_url: `https://github.com/acme/app-${n}`, pushed_at: "2026-10-14T10:00:00Z", ...over,
});

describe("headers and errors", () => {
  it("sends the token, GitHub's API version and a User-Agent, and only GETs", async () => {
    const f = fake(json({ login: "acme" }, 200, { "github-authentication-token-expiration": "2026-11-14 10:00:00 +0700" }));
    expect(await githubUser("github_pat_TESTONLY", f)).toEqual({ ok: true, data: { expiresAt: new Date("2026-11-14T03:00:00Z") } });
    expect(f.seen[0]).toMatchObject({ url: "https://api.github.com/user", method: "GET" });
    expect(f.seen[0].headers).toMatchObject({ Authorization: "Bearer github_pat_TESTONLY", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Watchbell" });
  });
  it("maps 401, 403, a used-up rate limit and 5xx", async () => {
    expect(await githubUser("t", fake(json({}, 401)))).toMatchObject({ ok: false, kind: "auth" });
    expect(await githubUser("t", fake(json({}, 403)))).toMatchObject({ ok: false, kind: "scope" });
    expect(await githubUser("t", fake(json({}, 403, { "x-ratelimit-remaining": "0" })))).toMatchObject({ ok: false, kind: "transient" });
    expect(await githubUser("t", fake(json({}, 502)))).toMatchObject({ ok: false, kind: "transient", error: "GitHub returned an error (502)." });
  });
  it("reads the token expiry in either of GitHub's formats", () => {
    expect(tokenExpiryFrom(new Headers({ "github-authentication-token-expiration": "2026-11-14 03:00:00 UTC" }))).toEqual(new Date("2026-11-14T03:00:00Z"));
    expect(tokenExpiryFrom(new Headers({ "github-authentication-token-expiration": "2026-11-14 10:00:00 +07:00" }))).toEqual(new Date("2026-11-14T03:00:00Z"));
    expect(tokenExpiryFrom(new Headers())).toBeNull();
    expect(tokenExpiryFrom(new Headers({ "github-authentication-token-expiration": "soon" }))).toBeNull();
  });
});

describe("listRepos", () => {
  it("pages until a short page and maps the fields", async () => {
    const f = fake(json(Array.from({ length: 100 }, (_, i) => repo(i))), json([repo(100, { archived: true, pushed_at: null })]));
    const r = await listRepos("t", f);
    expect(r.ok && r.data.repos).toHaveLength(101);
    expect(r.ok && r.data.truncated).toBe(false);
    expect(r.ok && r.data.repos[100]).toEqual({ id: "100", owner: "acme", name: "app-100", fullName: "acme/app-100", defaultBranch: "main", private: true, archived: true, htmlUrl: "https://github.com/acme/app-100", pushedAt: null });
    expect(f.seen.map((s) => new URL(s.url).searchParams.get("page"))).toEqual(["1", "2"]);
  });
  it("stops after three full pages and says the list is cut", async () => {
    const page = () => json(Array.from({ length: 100 }, (_, i) => repo(i)));
    const r = await listRepos("t", fake(page(), page(), page()));
    expect(r.ok && r.data.truncated).toBe(true);
  });
  it("a failure is a failure, never an empty list", async () => {
    expect(await listRepos("t", fake(json({}, 401)))).toMatchObject({ ok: false, kind: "auth" });
    expect(await listRepos("t", fake(json({ not: "a list" })))).toMatchObject({ ok: false, kind: "format" });
  });
});

describe("packageName", () => {
  it("reads only the name from the raw package.json", async () => {
    const f = fake(new Response(JSON.stringify({ name: "acme-shop", dependencies: { next: "16.4.0" } }), { status: 200 }));
    expect(await packageName("t", "acme/acme-shop", f)).toEqual({ ok: true, data: "acme-shop" });
    expect(f.seen[0].url).toBe("https://api.github.com/repos/acme/acme-shop/contents/package.json");
    expect(f.seen[0].headers.Accept).toBe("application/vnd.github.raw+json");
  });
  it("is null without a package.json, with a broken one, or an oversized one", async () => {
    expect(await packageName("t", "acme/x", fake(json({}, 404)))).toEqual({ ok: true, data: null });
    expect(await packageName("t", "acme/x", fake(new Response("{nope", { status: 200 })))).toEqual({ ok: true, data: null });
    expect(await packageName("t", "acme/x", fake(new Response(" ".repeat(300 * 1024), { status: 200 })))).toEqual({ ok: true, data: null });
  });
  it("never builds a URL from a name that isn't owner/repo", async () => {
    const f = fake();
    expect(await packageName("t", "../../user", f)).toEqual({ ok: true, data: null });
    expect(f.seen).toEqual([]);
    expect(isFullName("acme/app")).toBe(true);
    expect(isFullName("acme/../x")).toBe(false);
  });
});

describe("latestRun", () => {
  it("reads the newest run on the default branch, pull requests left out", async () => {
    const f = fake(json({ total_count: 12, workflow_runs: [{ status: "completed", conclusion: "failure", name: "CI", head_branch: "main", head_sha: "abc123", html_url: "https://github.com/acme/app/actions/runs/1", run_number: 41, updated_at: "2026-10-15T01:00:00Z" }] }));
    expect(await latestRun("t", "acme/app", "main", f)).toEqual({
      ok: true, data: { status: "completed", conclusion: "failure", name: "CI", branch: "main", sha: "abc123", url: "https://github.com/acme/app/actions/runs/1", at: "2026-10-15T01:00:00Z", runNumber: 41 },
    });
    const u = new URL(f.seen[0].url);
    expect(u.pathname).toBe("/repos/acme/app/actions/runs");
    expect(Object.fromEntries(u.searchParams)).toEqual({ per_page: "1", exclude_pull_requests: "true", branch: "main" });
  });
  it("says none when there is no run, and drops a link that isn't GitHub's", async () => {
    expect(await latestRun("t", "acme/app", null, fake(json({ total_count: 0, workflow_runs: [] })))).toEqual({ ok: true, data: { none: true } });
    const r = await latestRun("t", "acme/app", "main", fake(json({ total_count: 1, workflow_runs: [{ status: "in_progress", html_url: "https://evil.example/x" }] })));
    expect(r.ok && "status" in r.data && r.data.url).toBeNull();
  });
});
