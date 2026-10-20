import { describe, expect, it } from "vitest";
import { dependabotAlerts, rootFiles } from "./github-deps";
import { branchHead, createBranch, createPull, manifestAt, mergeWatchpostPull, openPull, putManifest, repoInfo, WRITE_SCOPE_ERROR } from "./github-write";

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
