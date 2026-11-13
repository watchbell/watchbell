import { describe, expect, it } from "vitest";
import { markerComment, openPulls } from "./github-pulls";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function fake(...answers: Response[]) {
  const seen: string[] = [];
  const fetch = (async (url: string) => {
    seen.push(url);
    return answers.shift() ?? json({ message: "unexpected" }, 500);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}
const SHA = "c".repeat(40);
const marker = (sha: string, verdict = "ok") => `<!-- watchbell-precheck {"v":1,"sha":"${sha}","verdict":"${verdict}","counts":{"critical":0,"high":0,"moderate":0,"low":0,"secrets":0,"env":0},"at":"2026-11-04T01:00:00.000Z"} -->\nbody`;

describe("openPulls", () => {
  it("lists open pull requests with their head commit", async () => {
    const f = fake(json([
      { number: 4, title: "Bump next", draft: false, html_url: "https://github.com/me/site/pull/4", head: { sha: SHA } },
      { number: 3, title: "x".repeat(300), draft: true, html_url: "https://evil.example/pull/3", head: { sha: SHA } },
    ]));
    const r = await openPulls("t", "me/site", f);
    expect(f.seen).toEqual(["https://api.github.com/repos/me/site/pulls?state=open&per_page=20&sort=created&direction=desc"]);
    expect(r).toEqual({ ok: true, data: [
      { number: 4, title: "Bump next", head: SHA, url: "https://github.com/me/site/pull/4", draft: false },
      { number: 3, title: "x".repeat(200), head: SHA, url: null, draft: true },
    ] });
  });
  it("refuses a name that isn't a repository", async () => {
    const f = fake();
    expect(await openPulls("t", "me/../x", f)).toMatchObject({ ok: false, kind: "format" });
    expect(f.seen).toHaveLength(0);
  });
});

describe("markerComment", () => {
  it("picks the newest valid marker the Actions bot wrote", async () => {
    const f = fake(json([
      { body: marker("a".repeat(40)), user: { login: "github-actions[bot]" } },
      { body: marker("b".repeat(40), "fix"), user: { login: "someone" } },
      { body: "<!-- watchbell-precheck {broken -->", user: { login: "github-actions[bot]" } },
      { body: marker(SHA, "check"), user: { login: "github-actions[bot]" } },
      { body: "thanks!", user: { login: "github-actions[bot]" } },
    ]));
    const r = await markerComment("t", "me/site", 4, f);
    expect(f.seen).toEqual(["https://api.github.com/repos/me/site/issues/4/comments?per_page=100"]);
    expect(r.ok && r.data).toMatchObject({ sha: SHA, verdict: "check" });
  });
  it("is null when there is no marker", async () => {
    expect(await markerComment("t", "me/site", 4, fake(json([{ body: "hi", user: { login: "me" } }])))).toEqual({ ok: true, data: null });
  });
  it("passes GitHub's failure through", async () => {
    expect(await markerComment("t", "me/site", 4, fake(json({ message: "Forbidden" }, 403)))).toMatchObject({ ok: false });
  });
});
