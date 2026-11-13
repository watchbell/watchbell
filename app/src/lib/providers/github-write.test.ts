import { describe, expect, it } from "vitest";
import { dependabotAlerts, rootFiles } from "./github-deps";
import {
  branchHead, commitFiles, createBranch, createPull, lockfileAt, manifestAt, mergeWatchpostPull, openPull, pullCommits, pullFiles, putManifest, putNewFile, repoInfo, tokenLogin, WRITE_SCOPE_ERROR,
} from "./github-write";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const SHA = "a".repeat(40);
const BRANCH = "watchpost/deps-0123abcd";

function recorder(answer: (url: string, init: RequestInit) => Response) {
  const seen: { url: string; method: string; body: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: String(init.method ?? "GET"), body: init.body ? JSON.parse(String(init.body)) : null });
    return answer(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

describe("github-write: never the default branch", () => {
  it("refuses before any request when the branch isn't a watchpost/deps-… branch or is the default", async () => {
    const r = recorder(() => json({}));
    for (const [branch, base] of [["main", "main"], [BRANCH, BRANCH], ["feature/x", "main"], ["watchpost/deps-zz", "main"]]) {
      expect(await createBranch("t", "o/r", branch, SHA, base, { fetch: r.fetch })).toMatchObject({ ok: false, kind: "format" });
      expect(await putManifest("t", "o/r", branch, base, "{}", SHA, "m", { fetch: r.fetch })).toMatchObject({ ok: false, kind: "format" });
      expect(await createPull("t", "o/r", branch, base, "t", "b", { fetch: r.fetch })).toMatchObject({ ok: false, kind: "format" });
    }
    expect(await createBranch("t", "../x", BRANCH, SHA, "main", { fetch: r.fetch })).toMatchObject({ ok: false });
    expect(r.seen).toEqual([]);
  });

  it("creates the branch from the head, writes package.json on it, and opens the PR against the default branch", async () => {
    const r = recorder((url, init) => (init.method === "POST" && url.endsWith("/pulls") ? json({ number: 7, html_url: "https://github.com/o/r/pull/7" }, 201) : json({}, 201)));
    expect(await createBranch("t", "o/r", BRANCH, SHA, "main", { fetch: r.fetch })).toEqual({ ok: true, data: true });
    expect(await putManifest("t", "o/r", BRANCH, "main", "{}\n", SHA, "chore", { fetch: r.fetch })).toEqual({ ok: true, data: true });
    expect(await createPull("t", "o/r", BRANCH, "main", "Judul", "Isi", { fetch: r.fetch })).toEqual({ ok: true, data: { number: 7, url: "https://github.com/o/r/pull/7" } });
    expect(r.seen).toEqual([
      { url: "https://api.github.com/repos/o/r/git/refs", method: "POST", body: { ref: `refs/heads/${BRANCH}`, sha: SHA } },
      { url: "https://api.github.com/repos/o/r/contents/package.json", method: "PUT", body: { message: "chore", content: Buffer.from("{}\n").toString("base64"), sha: SHA, branch: BRANCH } },
      { url: "https://api.github.com/repos/o/r/pulls", method: "POST", body: { title: "Judul", head: BRANCH, base: "main", body: "Isi", maintainer_can_modify: true } },
    ]);
  });

  it("squash-merges with a Watchbell commit title, also for a PR titled before the rename", async () => {
    const r = recorder(() => json({ sha: "b".repeat(40), merged: true }));
    await mergeWatchpostPull("t", "o/r", 7, BRANCH, "main", SHA, "Watchpost: update next to 15.0.5 (security fix)", { fetch: r.fetch });
    await mergeWatchpostPull("t", "o/r", 8, BRANCH, "main", SHA, "Watchbell: update next to 15.0.6 (security fix)", { fetch: r.fetch });
    expect(r.seen.map((x) => (x.body as { commit_title: string }).commit_title)).toEqual([
      "Watchbell: update next to 15.0.5 (security fix)",
      "Watchbell: update next to 15.0.6 (security fix)",
    ]);
  });

  it("words a 403 as the missing write permissions and a 401 as a bad token", async () => {
    const denied = recorder(() => json({ message: "Resource not accessible" }, 403));
    expect(await createBranch("t", "o/r", BRANCH, SHA, "main", { fetch: denied.fetch })).toEqual({ ok: false, kind: "scope", status: 403, error: WRITE_SCOPE_ERROR });
    const bad = recorder(() => json({}, 401));
    expect(await repoInfo("t", "o/r", { fetch: bad.fetch })).toMatchObject({ ok: false, kind: "auth" });
  });

  it("reads the repository, the branch head, package.json and an open PR", async () => {
    const r = recorder((url) => {
      if (url.endsWith("/repos/o/r")) return json({ default_branch: "main", permissions: { push: true } });
      if (url.includes("/git/ref/heads/main")) return json({ object: { sha: SHA } });
      if (url.includes("/git/ref/heads/")) return json({}, 404);
      if (url.includes("/contents/package.json")) return json({ sha: SHA, encoding: "base64", content: Buffer.from('{"a":1}').toString("base64") });
      if (url.includes("/pulls?")) return json([{ number: 3, html_url: "https://github.com/o/r/pull/3" }]);
      return json({}, 500);
    });
    expect(await repoInfo("t", "o/r", { fetch: r.fetch })).toEqual({ ok: true, data: { defaultBranch: "main", canPush: true } });
    expect(await branchHead("t", "o/r", "main", { fetch: r.fetch })).toEqual({ ok: true, data: SHA });
    expect(await branchHead("t", "o/r", BRANCH, { fetch: r.fetch })).toEqual({ ok: true, data: null });
    expect(await manifestAt("t", "o/r", SHA, { fetch: r.fetch })).toEqual({ ok: true, data: { sha: SHA, text: '{"a":1}' } });
    expect(await openPull("t", "o/r", "o", BRANCH, "main", { fetch: r.fetch })).toEqual({ ok: true, data: { number: 3, url: "https://github.com/o/r/pull/3" } });
    expect(r.seen.every((s) => s.method === "GET")).toBe(true);
    expect(r.seen.find((s) => s.url.includes("/pulls?"))?.url).toContain(`head=o%3A${encodeURIComponent(BRANCH)}`);
  });

  // Review T2b-fix I-1: lockfiles are often over the Contents API's 1 MB JSON limit, so they're read raw (up to 100 MB).
  it("reads an npm lockfile raw at a ref; a missing one is null; other paths are refused before any request", async () => {
    const accept: string[] = [];
    const r = recorder((url, init) => {
      accept.push(String((init.headers as Record<string, string>).Accept));
      if (url.includes("/contents/apps/web/package-lock.json?ref=")) return new Response('{"lockfileVersion":3}', { status: 200 });
      return json({ message: "Not Found" }, 404);
    });
    expect(await lockfileAt("t", "o/r", SHA, "apps/web/package-lock.json", { fetch: r.fetch })).toEqual({ ok: true, data: '{"lockfileVersion":3}' });
    expect(r.seen[0].url).toBe(`https://api.github.com/repos/o/r/contents/apps/web/package-lock.json?ref=${SHA}`);
    expect(accept[0]).toBe("application/vnd.github.raw+json");
    expect(await lockfileAt("t", "o/r", "main", "npm-shrinkwrap.json", { fetch: r.fetch })).toEqual({ ok: true, data: null });
    for (const p of ["pnpm-lock.yaml", "../package-lock.json", "a/../package-lock.json", ".npmrc"]) {
      expect(await lockfileAt("t", "o/r", "main", p, { fetch: r.fetch })).toMatchObject({ ok: false, kind: "format" });
    }
    expect(r.seen).toHaveLength(2);
  });
});

describe("github-deps (read-only)", () => {
  it("lists the root's files with their SHAs (GET only)", async () => {
    const r = recorder(() => json([
      { name: "package.json", type: "file", sha: "b".repeat(40), size: 900 }, { name: "src", type: "dir", sha: "c".repeat(40) },
      { name: "pnpm-lock.yaml", type: "file", sha: "d".repeat(40), size: 50_000 },
    ]));
    expect(await rootFiles("t", "o/r", "main", { fetch: r.fetch })).toEqual({ ok: true, data: [
      { name: "package.json", sha: "b".repeat(40), size: 900 }, { name: "pnpm-lock.yaml", sha: "d".repeat(40), size: 50_000 },
    ] });
    expect(r.seen).toEqual([{ url: "https://api.github.com/repos/o/r/contents/?ref=main", method: "GET", body: null }]);
    expect(await rootFiles("t", "o/r", "../x", { fetch: r.fetch })).toMatchObject({ ok: false, kind: "format" });
  });

  it("Dependabot: a 403 (no permission) or 404 (alerts off) is skipped with denied, not a failure", async () => {
    for (const status of [403, 404]) {
      const r = recorder(() => json({ message: "no" }, status));
      expect(await dependabotAlerts("t", "o/r", { fetch: r.fetch })).toEqual({ ok: true, data: { denied: true } });
    }
    const ok = recorder(() => json([]));
    expect(await dependabotAlerts("t", "o/r", { fetch: ok.fetch })).toEqual({ ok: true, data: { alerts: [] } });
    expect(ok.seen[0].url).toBe("https://api.github.com/repos/o/r/dependabot/alerts?state=open&ecosystem=npm&per_page=100");
  });
});

describe("github-write: the merge watcher's allow-list reads (audit M1)", () => {
  it("reads the PR's files, commits, one commit's files and the token's login", async () => {
    const r = recorder((url) => {
      if (url.endsWith("/pulls/7/files?per_page=100")) return json([{ filename: "package.json" }, { filename: "b.json", previous_filename: "a.json" }]);
      if (url.endsWith("/pulls/7/commits?per_page=100")) return json([{ sha: SHA, author: { login: "me" }, commit: { message: "m", author: { name: "Me", email: "me@x" } } }, { sha: SHA, author: null, commit: { message: "n", author: null } }]);
      if (url.endsWith(`/commits/${SHA}`)) return json({ files: [{ filename: "package-lock.json" }, { filename: "x", previous_filename: "y" }] });
      return json({ login: "me" });
    });
    expect(await pullFiles("t", "o/r", 7, { fetch: r.fetch })).toEqual({ ok: true, data: [{ filename: "package.json", previous: null }, { filename: "b.json", previous: "a.json" }] });
    expect(await pullCommits("t", "o/r", 7, { fetch: r.fetch })).toEqual({ ok: true, data: [
      { sha: SHA, login: "me", name: "Me", email: "me@x", message: "m" }, { sha: SHA, login: null, name: "", email: "", message: "n" },
    ] });
    expect(await commitFiles("t", "o/r", SHA, { fetch: r.fetch })).toEqual({ ok: true, data: ["package-lock.json", "x", "y"] });
    expect(await tokenLogin("t", { fetch: r.fetch })).toEqual({ ok: true, data: "me" });
    expect(r.seen.map((x) => x.method)).toEqual(["GET", "GET", "GET", "GET"]);
    expect(await pullFiles("t", "../r", 7, { fetch: r.fetch })).toMatchObject({ ok: false });
  });
});

// Watchbell 1.5 Build files: a create-only file put on the build-files branch.
describe("putNewFile", () => {
  const BF = "watchbell/build-files-0123abcd";
  it("creates a file without a sha, so GitHub never overwrites one", async () => {
    const r = recorder(() => json({ content: {} }, 201));
    expect(await putNewFile("t", "o/r", BF, "main", "apps/web/Dockerfile", "FROM x", "Add Dockerfile", { fetch: r.fetch })).toEqual({ ok: true, data: "created" });
    expect(r.seen[0].method).toBe("PUT");
    expect(r.seen[0].url).toBe("https://api.github.com/repos/o/r/contents/apps/web/Dockerfile");
    expect(r.seen[0].body).toEqual({ message: "Add Dockerfile", content: Buffer.from("FROM x").toString("base64"), branch: BF });
  });
  // Minor M6: a 422 is "exists" only when the file is really there on the branch.
  it("reads GitHub's 422 as a file that already exists when the file is there", async () => {
    const r = recorder((_u, init) => (init.method === "PUT" ? json({ message: "sha wasn't supplied" }, 422) : json({ sha: "x" })));
    expect(await putNewFile("t", "o/r", BF, "main", "Dockerfile", "x", "m", { fetch: r.fetch })).toEqual({ ok: true, data: "exists" });
    expect(r.seen.at(-1)).toMatchObject({ method: "GET", url: `https://api.github.com/repos/o/r/contents/Dockerfile?ref=${encodeURIComponent(BF)}` });
  });
  it("passes any other 422 on as a refusal", async () => {
    const r = recorder((_u, init) => (init.method === "PUT" ? json({ message: "too large" }, 422) : json({ message: "Not Found" }, 404)));
    expect(await putNewFile("t", "o/r", BF, "main", "Dockerfile", "x", "m", { fetch: r.fetch })).toMatchObject({ ok: false, kind: "format" });
  });
  it("refuses anything but the five build files, and any branch but its own", async () => {
    const r = recorder(() => json({}, 201));
    for (const p of ["src/index.ts", "../Dockerfile", "a/../Dockerfile", ".github/workflows/deploy.yml", "package.json"]) {
      expect(await putNewFile("t", "o/r", BF, "main", p, "x", "m", { fetch: r.fetch })).toMatchObject({ ok: false, kind: "format" });
    }
    for (const b of ["main", "watchbell/build-files-zz", BRANCH]) {
      expect(await putNewFile("t", "o/r", b, "main", "Dockerfile", "x", "m", { fetch: r.fetch })).toMatchObject({ ok: false, kind: "format" });
    }
    expect(r.seen).toEqual([]);
  });
  it("lets the build-files branch be created and pulled, but never merged or given a package.json", async () => {
    const r = recorder(() => json({ number: 3, html_url: "https://github.com/o/r/pull/3" }, 201));
    expect((await createBranch("t", "o/r", BF, SHA, "main", { fetch: r.fetch })).ok).toBe(true);
    expect((await createPull("t", "o/r", BF, "main", "t", "b", { fetch: r.fetch })).ok).toBe(true);
    expect(await putManifest("t", "o/r", BF, "main", "{}", SHA, "m", { fetch: r.fetch })).toMatchObject({ ok: false, kind: "format" });
    expect(await mergeWatchpostPull("t", "o/r", 3, BF, "main", SHA, "t", { fetch: r.fetch })).toMatchObject({ ok: false, kind: "format" });
  });
});
