import { describe, expect, it } from "vitest";
import type { Marker } from "@/lib/precheck/report";
import type { OpenPull } from "@/lib/providers/github-pulls";
import { checkPullRequests, type PrChecksDeps } from "./pr-checks-db";

const A = "a".repeat(40);
const B = "b".repeat(40);
const mk = (sha: string): Marker => ({ v: 1, sha, verdict: "fix", at: "2026-11-04T01:00:00.000Z", counts: { critical: 0, high: 1, moderate: 0, low: 0, secrets: 0, env: 0 } });
const pull = (n: number, head = A): OpenPull => ({ number: n, title: `PR ${n}`, head, url: `https://github.com/me/site/pull/${n}`, draft: false });

function deps(o: Partial<PrChecksDeps> & { markers?: Record<number, Marker | null> } = {}): PrChecksDeps & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    repo: async () => ({ fullName: "me/site" }),
    githubToken: async () => "t",
    pulls: async () => ({ ok: true, data: [pull(2, A), pull(1, B)] }),
    marker: async (_t, _r, n) => { asked.push(n); return { ok: true, data: o.markers?.[n] ?? null }; },
    now: () => new Date("2026-11-04T02:00:00Z"),
    ...o,
  };
}

describe("checkPullRequests", () => {
  it("says which pull requests the check looked at, and at which commit", async () => {
    const r = await checkPullRequests("app", deps({ markers: { 2: mk(A), 1: mk(A) } }));
    expect(r).toEqual({ ok: true, data: {
      repo: "me/site", checkedAt: "2026-11-04T02:00:00.000Z",
      rows: [
        { number: 2, title: "PR 2", url: "https://github.com/me/site/pull/2", draft: false, state: "checked", marker: mk(A) },
        { number: 1, title: "PR 1", url: "https://github.com/me/site/pull/1", draft: false, state: "old", marker: mk(A) },
      ],
    } });
  });
  it("marks a pull request the check never commented on", async () => {
    const r = await checkPullRequests("app", deps());
    expect(r.ok && r.data.rows.map((x) => x.state)).toEqual(["none", "none"]);
  });
  it("needs a linked repository and a token", async () => {
    expect(await checkPullRequests("app", deps({ repo: async () => null }))).toEqual({ ok: false, error: "Link a repository first." });
    expect(await checkPullRequests("app", deps({ githubToken: async () => null }))).toEqual({ ok: false, error: "GitHub isn't connected, or its token can't be read." });
  });
  it("reads comments on the 10 newest pull requests only", async () => {
    const d = deps({ pulls: async () => ({ ok: true, data: Array.from({ length: 14 }, (_, i) => pull(14 - i)) }) });
    const r = await checkPullRequests("app", d);
    expect(d.asked).toHaveLength(10);
    expect(r.ok && r.data.rows).toHaveLength(10);
  });
  it("passes GitHub's error through", async () => {
    const r = await checkPullRequests("app", deps({ pulls: async () => ({ ok: false, kind: "scope", error: "Resource not accessible by personal access token" }) }));
    expect(r).toEqual({ ok: false, error: "Resource not accessible by personal access token" });
  });
  // Review minor 6: a failed read isn't "the check isn't installed".
  it("marks a pull request whose comments can't be read as unread", async () => {
    const r = await checkPullRequests("app", deps({ marker: async () => ({ ok: false, kind: "transient", error: "x" }) }));
    expect(r.ok && r.data.rows.map((x) => x.state)).toEqual(["unread", "unread"]);
  });
});
