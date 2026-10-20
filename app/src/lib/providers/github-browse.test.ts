import { describe, expect, it } from "vitest";
import { branches, commits, readme, repoInfo, repoLanguages, runs } from "./github-browse";

type Seen = { url: string; method: string };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function fake(...answers: Response[]) {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: String(init.method ?? "GET") });
    return answers.shift() ?? json({ message: "unexpected" }, 500);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

describe("repository browser reads", () => {
  it("only GETs, and refuses odd names before building a URL", async () => {
    const f = fake(json([]));
    await commits("t", "me/site", "main", 20, f);
    expect(f.seen).toEqual([{ url: "https://api.github.com/repos/me/site/commits?sha=main&per_page=20", method: "GET" }]);
    expect(await commits("t", "me/../x", "main", 20, f)).toMatchObject({ ok: false, kind: "format" });
    expect(await readme("t", "me/site", "../x", 1000, f)).toMatchObject({ ok: false, kind: "format" });
    expect(f.seen).toHaveLength(1);
  });

  it("keeps a commit's title and login, never the email", async () => {
    const f = fake(json([{ sha: "a".repeat(40), html_url: "https://github.com/me/site/commit/aaa", author: null,
      commit: { message: "fix: thing\n\nlong body", author: { name: "Me", email: "me@example.com", date: "2026-10-16T00:00:00Z" } } }]));
    const r = await commits("t", "me/site", "main", 20, f);
    expect(r).toEqual({ ok: true, data: [{ sha: "a".repeat(40), title: "fix: thing", author: "Me", at: "2026-10-16T00:00:00Z", url: "https://github.com/me/site/commit/aaa" }] });
    expect(JSON.stringify(r)).not.toContain("example.com");
  });

  it("decodes the README and reports none on 404", async () => {
    const content = Buffer.from("# Hello").toString("base64");
    expect(await readme("t", "me/site", "main", 1000, fake(json({ path: "README.md", size: 7, content, encoding: "base64" })))).toEqual({ ok: true, data: { path: "README.md", text: "# Hello", size: 7 } });
    expect(await readme("t", "me/site", "main", 3, fake(json({ path: "README.md", size: 7, content, encoding: "base64" })))).toEqual({ ok: true, data: { path: "README.md", text: null, size: 7 } });
    expect(await readme("t", "me/site", "main", 1000, fake(json({}, 404)))).toEqual({ ok: true, data: null });
  });

  it("counts open pull requests from the Link header", async () => {
    const f = fake(
      json({ description: "d", language: "TypeScript", open_issues_count: 9, html_url: "https://github.com/me/site" }),
      json([{}], 200, { link: '<https://api.github.com/repositories/1/pulls?state=open&per_page=1&page=2>; rel="next", <https://api.github.com/repositories/1/pulls?state=open&per_page=1&page=4>; rel="last"' }),
    );
    expect(await repoInfo("t", "me/site", f)).toEqual({ ok: true, data: { description: "d", language: "TypeScript", openIssuesAndPulls: 9, openPulls: 4, htmlUrl: "https://github.com/me/site" } });
  });

  it("maps branches, runs and languages", async () => {
    expect(await branches("t", "me/site", fake(json([{ name: "main", protected: true, commit: { sha: "abc" } }])))).toEqual({ ok: true, data: { branches: [{ name: "main", sha: "abc", protected: true }], more: false } });
    const r = await runs("t", "me/site", 10, fake(json({ workflow_runs: [{ id: 1, name: "CI", status: "completed", conclusion: "success", html_url: "https://evil.com/x" }] })));
    expect(r).toMatchObject({ ok: true, data: [{ id: 1, name: "CI", conclusion: "success", url: null }] });
    const l = await repoLanguages("t", fake(json([{ full_name: "Me/Site", language: "Go" }, { full_name: "me/empty", language: null }])));
    expect(l.ok && [...l.data]).toEqual([["me/site", "Go"]]);
  });

  it("passes a used-up rate limit through", async () => {
    expect(await branches("t", "me/site", fake(json({}, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 90) }))))
      .toMatchObject({ ok: false, kind: "transient", status: 403 });
  });
});
