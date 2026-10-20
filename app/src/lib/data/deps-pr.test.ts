import { beforeEach, describe, expect, it, vi } from "vitest";
import { seal } from "@/lib/crypto";
import { fakeDb } from "@/lib/data/fake-db";
import type { ActionOutcome } from "@/lib/provider-actions";

const key = Buffer.alloc(32, 4).toString("base64");
const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown }, targetQuota: vi.fn(), dispatch: vi.fn() }));
// The registry the core sees (@/lib/extensions): the private edition's has the VM runner (r1), the open source one none.
const ext = vi.hoisted(() => ({ extensions: { nav: [], palette: [] } as { nav: never[]; palette: never[]; runner?: { queueLockfileJob: ReturnType<typeof vi.fn>; lockfileJobActive: ReturnType<typeof vi.fn> } } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: key }) }));
vi.mock("./provider-action-db", () => ({ finish: vi.fn(), targetQuota: h.targetQuota }));
vi.mock("./actions-lockfile-db", () => ({ dispatchLockfileUpdate: h.dispatch }));
vi.mock("@/lib/extensions", () => ext);

import { bumpPrAs, NEED_WRITE_TOKEN } from "./deps-pr";

const APP = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const SHA = "a".repeat(40);
const actor = { id: "mem-1", userId: "user-1" };
const sealed = seal("github_pat_WRITE_TESTONLY_0123456789", key);
const writeAcc = { id: "acc-w", provider: "github_write", credentialCiphertext: sealed.ciphertext, credentialIv: sealed.iv };
const link = { app: "acme-shop", fullName: "acme/acme-shop", owner: "acme", goneAt: null, lockfilePath: "package-lock.json" };
const vuln = { package: "next", installedVersion: "15.0.0", fixedVersion: "15.2.3", vulnId: "GHSA-f82v-jwr5-mffw", aliases: ["CVE-2025-29927"], severity: "critical", direct: true };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const manifest = JSON.stringify({ name: "acme-shop", dependencies: { next: "^15.0.0" } }, null, 2) + "\n";

// The Finisher: records the outcome; answers like finish() does.
function finisher() {
  const outcomes: ActionOutcome[] = [];
  const fin = async (o: ActionOutcome) => {
    outcomes.push(o);
    if (!("audit" in o)) return { ok: false as const, error: o.message };
    return "failed" in o ? { ok: false as const, error: o.failed.error } : { ok: true as const, message: o.message };
  };
  return { fin, outcomes };
}

function github(over: { pulls?: () => Response } = {}) {
  const seen: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const method = String(init.method ?? "GET");
    seen.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null });
    const u = new URL(url);
    if (method === "GET" && u.pathname === "/repos/acme/acme-shop") return json({ default_branch: "main", permissions: { push: true } });
    if (method === "GET" && u.pathname === "/repos/acme/acme-shop/git/ref/heads/main") return json({ object: { sha: SHA } });
    if (method === "GET" && u.pathname.startsWith("/repos/acme/acme-shop/git/ref/heads/")) return json({}, 404);
    if (method === "GET" && u.pathname === "/repos/acme/acme-shop/contents/package.json") return json({ sha: "b".repeat(40), encoding: "base64", content: Buffer.from(manifest).toString("base64") });
    if (method === "GET" && u.pathname === "/repos/acme/acme-shop/pulls") return over.pulls?.() ?? json([]);
    if (method === "POST" && u.pathname === "/repos/acme/acme-shop/git/refs") return json({}, 201);
    if (method === "PUT" && u.pathname === "/repos/acme/acme-shop/contents/package.json") return json({}, 200);
    if (method === "POST" && u.pathname === "/repos/acme/acme-shop/pulls") return json({ number: 12, html_url: "https://github.com/acme/acme-shop/pull/12" }, 201);
    return json({}, 500);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

beforeEach(() => {
  h.current = null;
  h.targetQuota.mockReset().mockResolvedValue(null);
  h.dispatch.mockReset().mockResolvedValue({ sent: false, why: "no actions repository" });
  delete ext.extensions.runner;
});

describe("bumpPrAs (Open package update PR)", () => {
  it("without the PR-write credential: a clear failure, nothing sent to GitHub", async () => {
    h.current = fakeDb([[]]);
    const g = github();
    const { fin } = finisher();
    expect(await bumpPrAs(actor, APP, REPO, fin, { fetch: g.fetch })).toEqual({ ok: false, error: NEED_WRITE_TOKEN });
    expect(g.seen).toEqual([]);
  });

  it("refuses bad ids and a used-up quota before reading anything", async () => {
    const { fin } = finisher();
    expect(await bumpPrAs(actor, "nope", REPO, fin)).toMatchObject({ ok: false });
    h.targetQuota.mockResolvedValue("Wait a minute.");
    h.current = fakeDb([]);
    expect(await bumpPrAs(actor, APP, REPO, fin)).toEqual({ ok: false, error: "Wait a minute." });
  });

  it("refuses when the app is no longer linked to that repository", async () => {
    h.current = fakeDb([[writeAcc], []]);
    const { fin } = finisher();
    expect(await bumpPrAs(actor, APP, REPO, fin, { fetch: github().fetch })).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
  });

  it("opens a PR from a new watchpost/deps-… branch; nothing is written to the default branch", async () => {
    h.current = fakeDb([[writeAcc], [link], [vuln]]);
    const g = github();
    const { fin, outcomes } = finisher();
    const r = await bumpPrAs(actor, APP, REPO, fin, { fetch: g.fetch });
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("Pull request #12 opened for acme-shop: next ^15.0.0 → ^15.2.3") });
    const writes = g.seen.filter((s) => s.method !== "GET");
    expect(writes.map((w) => `${w.method} ${new URL(w.url).pathname}`)).toEqual([
      "POST /repos/acme/acme-shop/git/refs", "PUT /repos/acme/acme-shop/contents/package.json", "POST /repos/acme/acme-shop/pulls",
    ]);
    const branch = String(writes[0].body?.ref).replace("refs/heads/", "");
    expect(branch).toMatch(/^watchpost\/deps-[0-9a-f]{8}$/);
    expect(writes[0].body?.sha).toBe(SHA);
    expect(writes[1].body?.branch).toBe(branch);
    expect(Buffer.from(String(writes[1].body?.content), "base64").toString()).toBe(manifest.replace("^15.0.0", "^15.2.3"));
    expect(writes[2].body).toMatchObject({ head: branch, base: "main", title: "Watchbell: update next to 15.2.3 (security fix)" });
    expect(String(writes[2].body?.body)).toContain("run `npm install`");
    expect(outcomes[0]).toMatchObject({ done: true, audit: { message: "Package update PR opened · acme-shop · #12", resourceId: APP } });
  });

  it("the same bumps with an open PR: answers with that PR, writes nothing", async () => {
    h.current = fakeDb([[writeAcc], [link], [vuln]]);
    const g = github({ pulls: () => json([{ number: 9, html_url: "https://github.com/acme/acme-shop/pull/9" }]) });
    const { fin } = finisher();
    expect(await bumpPrAs(actor, APP, REPO, fin, { fetch: g.fetch })).toEqual({ ok: true, message: "Pull request #9 for these updates is already open." });
    expect(g.seen.every((s) => s.method === "GET")).toBe(true);
  });

  it("nothing fixable: refused without any GitHub call", async () => {
    h.current = fakeDb([[writeAcc], [link], [{ ...vuln, direct: false }]]);
    const g = github();
    const { fin } = finisher();
    expect(await bumpPrAs(actor, APP, REPO, fin, { fetch: g.fetch })).toMatchObject({ ok: false, error: expect.stringContaining("Nothing to update") });
    expect(g.seen).toEqual([]);
  });
});

describe("bumpPrAs, automatic security fixes", () => {
  const AUTO = { auto: { severities: ["critical", "high"] as ("critical" | "high")[] } };
  // pulls?head=… is openPull (none); pulls?state=open&per_page=100 is the open Watchbell PR list.
  const pullsWith = (list: unknown[]) => (url: string) => (new URL(url).searchParams.has("head") ? json([]) : json(list));
  const withPulls = (list: unknown[], branchSha = false) => {
    const base = github();
    const seen = base.seen;
    const fetch = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const method = String(init.method ?? "GET");
      if (method === "GET" && u.pathname === "/repos/acme/acme-shop/pulls") {
        seen.push({ url, method, body: null });
        return pullsWith(list)(url);
      }
      if (branchSha && method === "GET" && u.pathname.startsWith("/repos/acme/acme-shop/git/ref/heads/watchpost") && seen.some((s) => s.method === "POST" && s.url.endsWith("/pulls"))) {
        seen.push({ url, method, body: null });
        return json({ object: { sha: "c".repeat(40) } });
      }
      return base.fetch(url, init);
    }) as unknown as typeof globalThis.fetch;
    return { fetch, seen };
  };

  it("opens the PR (auto body) and records it for the watcher", async () => {
    const f = fakeDb([[writeAcc], [link], [vuln]], [[]]);
    h.current = f;
    const g = withPulls([], true);
    const { fin } = finisher();
    const r = await bumpPrAs(actor, APP, REPO, fin, { fetch: g.fetch, ...AUTO, proposalId: "44444444-4444-4444-8444-444444444444" });
    expect(r).toMatchObject({ ok: true });
    const pr = g.seen.find((s) => s.method === "POST" && s.url.endsWith("/pulls"));
    expect(String(pr?.body?.body)).toContain("opened **automatically**");
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].calls.find((c) => c.method === "values")?.args[0]).toMatchObject({
      repoId: REPO, appId: APP, number: 12, headSha: "c".repeat(40), packages: ["next"], auto: true, stage: "checks", stageText: "PR #12: waiting for CI",
      proposalId: "44444444-4444-4444-8444-444444444444",
    });
  });

  it("auto refuses a major jump or an unchosen severity, without any GitHub write", async () => {
    for (const [v, want] of [[{ ...vuln, fixedVersion: "16.0.1" }, "jumps a major version"], [{ ...vuln, severity: "moderate" }, "selected severity"]] as const) {
      h.current = fakeDb([[writeAcc], [link], [v]]);
      const g = withPulls([]);
      const { fin } = finisher();
      expect(await bumpPrAs(actor, APP, REPO, fin, { fetch: g.fetch, ...AUTO })).toMatchObject({ ok: false, error: expect.stringContaining(want) });
      expect(g.seen.filter((s) => s.method !== "GET")).toEqual([]);
    }
  });

  it("never two open Watchbell PRs for the same package (stored packages, else the title)", async () => {
    const open = [{ number: 5, title: "Watchpost: update next ke 15.1.0 (perbaikan keamanan)", head: { ref: "watchpost/deps-0a0b0c0d", sha: "d".repeat(40), repo: { full_name: "acme/acme-shop" } }, base: { ref: "main" } }];
    h.current = fakeDb([[writeAcc], [link], [vuln], []]);
    const g = withPulls(open);
    const { fin } = finisher();
    expect(await bumpPrAs(actor, APP, REPO, fin, { fetch: g.fetch })).toMatchObject({ ok: false, error: expect.stringContaining("Pull request #5 for the same package is already open") });
    expect(g.seen.filter((s) => s.method !== "GET")).toEqual([]);
    // Someone else's PR (not from a watchpost/deps-… branch) doesn't count.
    h.current = fakeDb([[writeAcc], [link], [vuln]], [[]]);
    const other = withPulls([{ ...open[0], head: { ...open[0].head, ref: "feature/x" } }]);
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: other.fetch })).toMatchObject({ ok: true });
  });
});

// The lockfile of a recorded update PR: the VM runner (private edition, registry r1) queues a job and GitHub Actions in
// the owner's actions repository is asked as well (each skips when not set up); without a runner, Actions alone.
describe("bumpPrAs, the lockfile hand-off", () => {
  const branchShaFetch = () => {
    const base = github();
    const fetch = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      if (String(init.method ?? "GET") === "GET" && u.pathname.startsWith("/repos/acme/acme-shop/git/ref/heads/watchpost") && base.seen.some((s) => s.method === "POST" && s.url.endsWith("/pulls"))) {
        return json({ object: { sha: "c".repeat(40) } });
      }
      return base.fetch(url, init);
    }) as unknown as typeof globalThis.fetch;
    return fetch;
  };
  const dispatched = { repo: "acme/acme-shop", branch: expect.stringMatching(/^watchpost\/deps-[0-9a-f]{8}$/), lockfilePath: "package-lock.json", prNumber: 12 };

  it("without a runner extension: dispatches the GitHub Actions workflow (the open source edition's path)", async () => {
    h.current = fakeDb([[writeAcc], [link], [vuln]], [[]]);
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: branchShaFetch() })).toMatchObject({ ok: true });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatch).toHaveBeenCalledWith("github_pat_WRITE_TESTONLY_0123456789", dispatched);
  });

  it("with the runner extension: queues a runner job, and still asks GitHub Actions (unchanged private behaviour)", async () => {
    const runner = { queueLockfileJob: vi.fn().mockResolvedValue({ queued: true, jobId: "job-1" }), lockfileJobActive: vi.fn() };
    ext.extensions.runner = runner;
    h.current = fakeDb([[writeAcc], [link], [vuln]], [[]]);
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: branchShaFetch() })).toMatchObject({ ok: true });
    expect(runner.queueLockfileJob).toHaveBeenCalledTimes(1);
    expect(runner.queueLockfileJob).toHaveBeenCalledWith({
      repoId: REPO, branch: dispatched.branch, headSha: "c".repeat(40), prNumber: 12, lockfilePath: "package-lock.json", targets: [{ name: "next", version: "15.2.3" }],
    });
    expect(h.dispatch).toHaveBeenCalledWith("github_pat_WRITE_TESTONLY_0123456789", dispatched);
    expect(runner.queueLockfileJob.mock.invocationCallOrder[0]).toBeLessThan(h.dispatch.mock.invocationCallOrder[0]);
  });

  it("a runner that throws doesn't stop the Actions dispatch or fail the opened PR", async () => {
    ext.extensions.runner = { queueLockfileJob: vi.fn().mockRejectedValue(new Error("boom")), lockfileJobActive: vi.fn() };
    h.current = fakeDb([[writeAcc], [link], [vuln]], [[]]);
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: branchShaFetch() })).toMatchObject({ ok: true });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });
});
