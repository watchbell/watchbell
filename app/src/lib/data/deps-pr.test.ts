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

import { autoBumpReady, bumpPrAs, frameworkFixes, NEED_WRITE_TOKEN, productionMismatches } from "./deps-pr";

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

  // Watchbell 1.2.1 (owner 1a): a moderate advisory is fixed like a high one while Moderate is on; the PR, its record
  // for the watcher (and so the watcher's Telegram messages) are the same as for high.
  it("a moderate advisory: opened automatically while Moderate is on, refused while it is off", async () => {
    const moderate = { ...vuln, severity: "moderate" };
    const f = fakeDb([[writeAcc], [link], [moderate]], [[]]);
    h.current = f;
    const g = withPulls([], true);
    const on = await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch, auto: { severities: ["critical", "high", "moderate"] }, proposalId: "44444444-4444-4444-8444-444444444444" });
    expect(on).toMatchObject({ ok: true, message: expect.stringContaining("Pull request #12 opened for acme-shop") });
    expect(String(g.seen.find((s) => s.method === "POST" && s.url.endsWith("/pulls"))?.body?.body)).toContain("opened **automatically**");
    expect(f.writes[0].calls.find((c) => c.method === "values")?.args[0]).toMatchObject({ auto: true, stage: "checks", stageText: "PR #12: waiting for CI", packages: ["next"] });
    h.current = fakeDb([[writeAcc], [link], [moderate]]);
    const off = withPulls([]);
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: off.fetch, ...AUTO })).toMatchObject({ ok: false, error: expect.stringContaining("selected severity") });
    expect(off.seen.filter((s) => s.method !== "GET")).toEqual([]);
    // Fix round 1 (review minor 7): a moderate advisory on a devDependency never opens an automatic PR.
    h.current = fakeDb([[writeAcc], [link], [{ ...moderate, dev: true }]]);
    const dev = withPulls([]);
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: dev.fetch, auto: { severities: ["critical", "high", "moderate"] } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("selected severity") });
    expect(dev.seen.filter((s) => s.method !== "GET")).toEqual([]);
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

// Watchbell 1.2.1 (owner 24 Oct): the update PR targets the branch Vercel deploys to production (shopfront is live
// from web-revamp while main is stale), when that branch exists in the repository; otherwise the default branch.
describe("bumpPrAs, the PR's base branch", () => {
  const PROD_SHA = "e".repeat(40);
  const withProd = (prodExists: boolean) => {
    const base = github();
    const fetch = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const method = String(init.method ?? "GET");
      if (method === "GET" && u.pathname === "/repos/acme/acme-shop/git/ref/heads/web-revamp") {
        base.seen.push({ url, method, body: null });
        return prodExists ? json({ object: { sha: PROD_SHA } }) : json({ message: "Not Found" }, 404);
      }
      if (method === "GET" && u.pathname.startsWith("/repos/acme/acme-shop/git/ref/heads/watchpost") && base.seen.some((s) => s.method === "POST" && s.url.endsWith("/pulls"))) {
        return json({ object: { sha: "c".repeat(40) } });
      }
      return base.fetch(url, init);
    }) as unknown as typeof globalThis.fetch;
    return { fetch, seen: base.seen };
  };
  const prodLink = { ...link, meta: { productionBranch: "web-revamp" } };

  it("the production branch exists: the PR branches from it and targets it, and the watcher gets it as the base", async () => {
    const f = fakeDb([[writeAcc], [prodLink], [vuln]], [[]]);
    h.current = f;
    const g = withProd(true);
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch })).toMatchObject({ ok: true });
    const ref = g.seen.find((s) => s.method === "POST" && s.url.endsWith("/git/refs"));
    expect(ref?.body?.sha).toBe(PROD_SHA);
    expect(g.seen.find((s) => s.method === "GET" && s.url.includes("/contents/package.json"))?.url).toContain(`ref=${PROD_SHA}`);
    expect(g.seen.find((s) => s.method === "POST" && s.url.endsWith("/pulls"))?.body).toMatchObject({ base: "web-revamp" });
    expect(f.writes[0].calls.find((c) => c.method === "values")?.args[0]).toMatchObject({ baseBranch: "web-revamp" });
  });

  it("the production branch isn't in the repository, or the app has none: the default branch, as before", async () => {
    for (const l of [prodLink, link, { ...link, meta: { productionBranch: null } }, { ...link, meta: { productionBranch: "../evil" } }]) {
      const f = fakeDb([[writeAcc], [l], [vuln]], [[]]);
      h.current = f;
      const g = withProd(false);
      expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch })).toMatchObject({ ok: true });
      expect(g.seen.find((s) => s.method === "POST" && s.url.endsWith("/git/refs"))?.body?.sha).toBe(SHA);
      expect(g.seen.find((s) => s.method === "POST" && s.url.endsWith("/pulls"))?.body).toMatchObject({ base: "main" });
      expect(f.writes[0].calls.find((c) => c.method === "values")?.args[0]).toMatchObject({ baseBranch: "main" });
    }
  });

  it("can't tell whether the production branch exists (GitHub error): fails without writing anything", async () => {
    h.current = fakeDb([[writeAcc], [prodLink], [vuln]]);
    const base = github();
    const fetch = (async (url: string, init: RequestInit) => {
      if (new URL(url).pathname.endsWith("/git/ref/heads/web-revamp")) return json({}, 502);
      return base.fetch(url, init);
    }) as unknown as typeof globalThis.fetch;
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch })).toMatchObject({ ok: false });
    expect(base.seen.filter((s) => s.method !== "GET")).toEqual([]);
  });
});

// Watchbell 1.2.2 (D15, incident 25 Oct): production was deployed by the CLI from web-revamp while the project's production
// branch was main; the update PR went to main, was merged, and Vercel deployed stale main. Fix round 1: the PR targets the
// Git branch production was built from when the repository has it; otherwise (a CLI deploy, a missing branch, a reading
// older than 30 minutes) it never opens on its own, and an approved one opens as a draft with the warning on top.
describe("bumpPrAs and productionMismatches, what production was really built from", () => {
  const AUTO = { auto: { severities: ["critical", "high"] as ("critical" | "high")[] } };
  const REVAMP_SHA = "e".repeat(40);
  const fresh = () => new Date(Date.now() - 5 * 60_000).toISOString();
  const recorded = (o: { revamp?: boolean; draft422?: boolean } = {}) => {
    const base = github();
    const fetch = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const method = String(init.method ?? "GET");
      if (method === "GET" && u.pathname === "/repos/acme/acme-shop/git/ref/heads/web-revamp") {
        base.seen.push({ url, method, body: null });
        return o.revamp ? json({ object: { sha: REVAMP_SHA } }) : json({ message: "Not Found" }, 404);
      }
      if (method === "GET" && u.pathname.startsWith("/repos/acme/acme-shop/git/ref/heads/watchpost") && base.seen.some((s) => s.method === "POST" && s.url.endsWith("/pulls"))) {
        return json({ object: { sha: "c".repeat(40) } });
      }
      if (o.draft422 && method === "POST" && u.pathname === "/repos/acme/acme-shop/pulls" && init.body && JSON.parse(String(init.body)).draft) {
        base.seen.push({ url, method, body: JSON.parse(String(init.body)) });
        return json({ message: "Draft pull requests are not supported in this repository." }, 422);
      }
      return base.fetch(url, init);
    }) as unknown as typeof globalThis.fetch;
    return { fetch, seen: base.seen };
  };
  const withSource = (productionSource: unknown) => ({ ...link, meta: { productionBranch: "main", productionSource } });
  const pulls = (g: ReturnType<typeof recorded>) => g.seen.filter((s) => s.method === "POST" && s.url.endsWith("/pulls"));

  it("a CLI deploy, a branch the repository doesn't have, or an old reading: no automatic PR, nothing written", async () => {
    for (const [src, want] of [
      [{ kind: "cli", at: fresh() }, "Production was deployed from the CLI, not built from main. Merging this PR would deploy main to production and replace what is live."],
      [{ kind: "git", ref: "web-revamp", at: fresh() }, "Production was built from web-revamp, not main. Merging this PR would deploy main to production and replace what is live."],
      [{ kind: "git", ref: "main", at: new Date(Date.now() - 31 * 60_000).toISOString() }, "Watchbell can't confirm what production is built from (no reading in the last 30 minutes). Merging this PR could deploy main to production and replace what is live."],
    ] as const) {
      h.current = fakeDb([[writeAcc], [withSource(src)], [vuln]]);
      const g = recorded({ revamp: false });
      const r = await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch, ...AUTO });
      expect(r).toEqual({ ok: false, error: `Automatic PR not opened: ${want} The proposal waits for your approval.` });
      expect(g.seen.filter((s) => s.method !== "GET")).toEqual([]);
    }
  });

  it("built from a branch the repository has: the PR (automatic too) branches from it and targets it, the branch the scan read", async () => {
    const f = fakeDb([[writeAcc], [withSource({ kind: "git", ref: "web-revamp", at: fresh() })], [vuln]], [[]]);
    h.current = f;
    const g = recorded({ revamp: true });
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch, ...AUTO })).toMatchObject({ ok: true });
    expect(g.seen.find((s) => s.method === "POST" && s.url.endsWith("/git/refs"))?.body?.sha).toBe(REVAMP_SHA);
    expect(pulls(g)[0].body).toMatchObject({ base: "web-revamp" });
    expect(pulls(g)[0].body?.draft).toBeUndefined();
    expect(f.writes[0].calls.find((c) => c.method === "values")?.args[0]).toMatchObject({ baseBranch: "web-revamp" });
  });

  it("built from the PR's base and read lately: the automatic PR opens as before (not a draft)", async () => {
    h.current = fakeDb([[writeAcc], [withSource({ kind: "git", ref: "main", sha: "f".repeat(40), at: fresh() })], [vuln]], [[]]);
    const g = recorded();
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch, ...AUTO })).toMatchObject({ ok: true });
    expect(pulls(g)[0].body).toMatchObject({ base: "main" });
    expect(String(pulls(g)[0].body?.body)).not.toContain("[!WARNING]");
  });

  it("the owner approved it with a CLI deploy: a draft PR with the warning on top", async () => {
    h.current = fakeDb([[writeAcc], [withSource({ kind: "cli", at: fresh() })], [vuln]], [[]]);
    const g = recorded();
    const r = await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch });
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("Opened as a draft: Production was deployed from the CLI, not built from main.") });
    expect(pulls(g)[0].body).toMatchObject({ base: "main", draft: true });
    expect(String(pulls(g)[0].body?.body)).toMatch(/^> \[!WARNING\]\n> Production was deployed from the CLI, not built from main\. Merging this PR would deploy main to production and replace what is live\./);
  });

  it("a repository that can't have draft PRs (422): opened as a normal PR, the warning still on top", async () => {
    h.current = fakeDb([[writeAcc], [withSource({ kind: "cli", at: fresh() })], [vuln]], [[]]);
    const g = recorded({ draft422: true });
    const r = await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch });
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("Opened as a normal pull request (this repository can't have drafts), with the warning on top: Production was deployed from the CLI") });
    expect(r.ok && r.message).not.toContain("Opened as a draft");
    expect(pulls(g).map((p) => p.body?.draft)).toEqual([true, undefined]);
    expect(String(pulls(g)[1].body?.body)).toContain("[!WARNING]");
  });

  // Fix round 2 (re-review minor 4): the plan comes from the scan; the scan's key says which branch it read.
  it("the stored scan read another branch than the PR's base: refused with 'scan again', nothing written", async () => {
    for (const [lockfileSha, src, revamp, want] of [
      ["br:web-revamp:abc123", { kind: "cli", at: fresh() }, false, "read web-revamp, but this pull request would go to main"],
      ["abc123", { kind: "git", ref: "web-revamp", at: fresh() }, true, "read main, but this pull request would go to web-revamp"],
    ] as const) {
      h.current = fakeDb([[writeAcc], [{ ...withSource(src), lockfileSha }], [vuln]]);
      const g = recorded({ revamp });
      const r = await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch });
      expect(r).toEqual({ ok: false, error: `The dependency scan of acme-shop ${want}. Scan again (Dependencies › Scan now on the app page), then ask again.` });
      expect(g.seen.filter((s) => s.method !== "GET")).toEqual([]);
    }
    // The same branch: opened.
    h.current = fakeDb([[writeAcc], [{ ...withSource({ kind: "git", ref: "web-revamp", at: fresh() }), lockfileSha: "br:web-revamp:abc123" }], [vuln]], [[]]);
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: recorded({ revamp: true }).fetch })).toMatchObject({ ok: true });
  });

  it("productionMismatches: per app, against the base prBase would pick", async () => {
    const A2 = "66666666-6666-4666-8666-666666666666";
    const A3 = "77777777-7777-4777-8777-777777777777";
    const A4 = "88888888-8888-4888-8888-888888888888";
    const now = new Date();
    const at = new Date(now.getTime() - 60_000).toISOString();
    h.current = fakeDb([[
      { appId: APP, repoId: REPO, defaultBranch: "main", meta: { productionBranch: "main", productionSource: { kind: "cli", at } } },
      { appId: A2, repoId: REPO, defaultBranch: "main", meta: { productionBranch: "web-revamp", productionSource: { kind: "git", ref: "web-revamp", at } } },
      // Built from a branch other than the production branch: the PR targets that branch, so nothing against it here.
      { appId: A3, repoId: REPO, defaultBranch: "main", meta: { productionBranch: "main", productionSource: { kind: "git", ref: "web-revamp", at } } },
      { appId: A4, repoId: REPO, defaultBranch: "main", meta: { productionBranch: "main", productionSource: { kind: "git", ref: "main" } } },
    ]]);
    const m = await productionMismatches([{ appId: APP, repoId: REPO }, { appId: A2, repoId: REPO }, { appId: A3, repoId: REPO }, { appId: A4, repoId: REPO }, { appId: "nope", repoId: REPO }], now);
    expect([...m.keys()]).toEqual([APP, A4]);
    expect(m.get(APP)).toBe("Production was deployed from the CLI, not built from main. Merging this PR would deploy main to production and replace what is live.");
    expect(m.get(A4)).toContain("can't confirm");
    h.current = fakeDb([]);
    expect(await productionMismatches([], now)).toEqual(new Map());
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

  // Watchbell 1.2.2 (D18): the result asks for npm install only when nothing will update the lockfile.
  it("drops the npm install hint when the workflow or the runner took the lockfile, and keeps it otherwise", async () => {
    const message = async () => {
      h.current = fakeDb([[writeAcc], [link], [vuln]], [[]]);
      const r = await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: branchShaFetch() });
      return r.ok ? r.message : r.error;
    };
    expect(await message()).toBe("Pull request #12 opened for acme-shop: next ^15.0.0 → ^15.2.3. Run npm install on the branch before merging.");
    h.dispatch.mockResolvedValue({ sent: true });
    expect(await message()).toBe("Pull request #12 opened for acme-shop: next ^15.0.0 → ^15.2.3.");
    // Set up but not sent (a lockfile the workflow can't update, or GitHub refused): the hint stays.
    h.dispatch.mockResolvedValue({ sent: false, why: "invalid" });
    expect(await message()).toContain("Run npm install on the branch before merging.");
    ext.extensions.runner = { queueLockfileJob: vi.fn().mockResolvedValue({ queued: true, jobId: "job-1" }), lockfileJobActive: vi.fn() };
    expect(await message()).toBe("Pull request #12 opened for acme-shop: next ^15.0.0 → ^15.2.3.");
    ext.extensions.runner = { queueLockfileJob: vi.fn().mockResolvedValue({ queued: false, why: "no runner" }), lockfileJobActive: vi.fn() };
    expect(await message()).toContain("Run npm install on the branch before merging.");
  });

  it("a runner that throws doesn't stop the Actions dispatch or fail the opened PR", async () => {
    ext.extensions.runner = { queueLockfileJob: vi.fn().mockRejectedValue(new Error("boom")), lockfileJobActive: vi.fn() };
    h.current = fakeDb([[writeAcc], [link], [vuln]], [[]]);
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: branchShaFetch() })).toMatchObject({ ok: true });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });
});

// Watchbell 1.2 (owner 23 Oct): FrameworkVulnerable's update PR, and the app's Vercel Root Directory (a monorepo).
describe("bumpPrAs, Next.js from the Security card, in the app's Root Directory", () => {
  const sec = (o: Record<string, unknown> = {}) => ({
    version: "16.3.8", status: "vulnerable",
    findings: [
      { id: "GHSA-aaaa-bbbb-cccc", cve: "CVE-2026-1111", summary: "Cache poisoning", severity: "CRITICAL", fixed: "16.4.1" },
      { id: "GHSA-dddd-eeee-ffff", cve: null, summary: "SSRF", severity: "HIGH", fixed: "16.3.9" },
    ], ...o,
  });
  const mono = { ...link, meta: { teamId: "team_1", rootDirectory: "apps/web" }, lockfilePath: "apps/web/package-lock.json" };
  const webManifest = JSON.stringify({ name: "web", dependencies: { next: "^16.3.8", react: "19.2.0" }, devDependencies: { "eslint-config-next": "16.3.8" } }, null, 2) + "\n";
  const monoGithub = (pkg = webManifest) => {
    const seen: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      const method = String(init.method ?? "GET");
      seen.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null });
      const u = new URL(url);
      if (method === "GET" && u.pathname === "/repos/acme/acme-shop") return json({ default_branch: "main", permissions: { push: true } });
      if (method === "GET" && u.pathname === "/repos/acme/acme-shop/git/ref/heads/main") return json({ object: { sha: SHA } });
      if (method === "GET" && u.pathname.startsWith("/repos/acme/acme-shop/git/ref/heads/watchpost")) {
        return seen.some((s) => s.method === "POST" && s.url.endsWith("/pulls")) ? json({ object: { sha: "c".repeat(40) } }) : json({}, 404);
      }
      if (method === "GET" && u.pathname === "/repos/acme/acme-shop/contents/apps/web/package.json") return json({ sha: "b".repeat(40), encoding: "base64", content: Buffer.from(pkg).toString("base64") });
      if (method === "GET" && u.pathname === "/repos/acme/acme-shop/pulls") return json([]);
      if (method === "POST" && u.pathname === "/repos/acme/acme-shop/git/refs") return json({}, 201);
      if (method === "PUT" && u.pathname === "/repos/acme/acme-shop/contents/apps/web/package.json") return json({}, 200);
      if (method === "POST" && u.pathname === "/repos/acme/acme-shop/pulls") return json({ number: 21, html_url: "https://github.com/acme/acme-shop/pull/21" }, 201);
      return json({}, 500);
    }) as unknown as typeof globalThis.fetch;
    return { fetch, seen };
  };

  it("updates next and eslint-config-next to the version that clears the advisories, in apps/web/package.json", async () => {
    const f = fakeDb([[writeAcc], [mono], [sec()]], [[]]);
    h.current = f;
    const g = monoGithub();
    const r = await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch, framework: true });
    expect(r).toMatchObject({ ok: true, message: "Pull request #21 opened for acme-shop: next ^16.3.8 → ^16.4.1, eslint-config-next 16.3.8 → 16.4.1. Run npm install in apps/web on the branch before merging." });
    const writes = g.seen.filter((s) => s.method !== "GET");
    expect(writes.map((w) => `${w.method} ${new URL(w.url).pathname}`)).toEqual([
      "POST /repos/acme/acme-shop/git/refs", "PUT /repos/acme/acme-shop/contents/apps/web/package.json", "POST /repos/acme/acme-shop/pulls",
    ]);
    const edited = JSON.parse(Buffer.from(String(writes[1].body?.content), "base64").toString());
    expect(edited).toEqual({ name: "web", dependencies: { next: "^16.4.1", react: "19.2.0" }, devDependencies: { "eslint-config-next": "16.4.1" } });
    // review T1 minor 7: eslint-config-next is "updated to match", not vulnerable; the folder is named
    expect(writes[2].body).toMatchObject({ base: "main", title: "Watchbell: update next to 16.4.1 in apps/web (security fix)" });
    expect(String(writes[2].body?.body)).toContain("CVE-2026-1111");
    expect(String(writes[2].body?.body)).toContain("Updated to match next (no advisory of its own): `eslint-config-next` `16.3.8` → `16.4.1`.");
    expect(String(writes[2].body?.body)).toContain("run `npm install` in `apps/web`");
    // Only the write account, the link and the Next.js check are read: not the dependency scan's advisories.
    expect(f.queries).toHaveLength(3);
    expect(f.writes[0].calls.find((c) => c.method === "values")?.args[0]).toMatchObject({ packages: ["next", "eslint-config-next"], number: 21 });
    expect(h.dispatch).toHaveBeenCalledWith("github_pat_WRITE_TESTONLY_0123456789", expect.objectContaining({ lockfilePath: "apps/web/package-lock.json", prNumber: 21 }));
  });

  it("without eslint-config-next in package.json: next alone", async () => {
    h.current = fakeDb([[writeAcc], [mono], [sec()]], [[]]);
    const g = monoGithub(JSON.stringify({ dependencies: { next: "16.3.8" } }));
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch, framework: true })).toMatchObject({ ok: true, message: expect.stringContaining("next 16.3.8 → 16.4.1.") });
    const pr = g.seen.find((s) => s.method === "POST" && s.url.endsWith("/pulls"));
    expect(pr?.body).toMatchObject({ title: "Watchbell: update next to 16.4.1 in apps/web (security fix)" });
  });

  // D15 (re-review r2 minor 5): a framework PR's plan is the Next.js check, not the scan: no "scan again".
  it("a framework PR isn't refused when the stored scan read another branch", async () => {
    h.current = fakeDb([[writeAcc], [{ ...mono, lockfileSha: "br:web-revamp:abc123" }], [sec()]], [[]]);
    const g = monoGithub(JSON.stringify({ dependencies: { next: "16.3.8" } }));
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch, framework: true })).toMatchObject({ ok: true });
    h.current = fakeDb([[writeAcc], [{ ...mono, lockfileSha: "br:web-revamp:abc123" }], [vuln]]);
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: monoGithub().fetch })).toMatchObject({ ok: false, error: expect.stringContaining("Scan again") });
  });

  it("refuses when the check isn't vulnerable any more, or package.json already allows the fix; nothing written", async () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [sec({ status: "ok", findings: [] }), webManifest, "Nothing to update in acme-shop"],
      [sec({ findings: [{ id: "GHSA-x", cve: null, summary: "", severity: "HIGH", fixed: null }] }), webManifest, "Nothing to update in acme-shop"],
      [sec(), JSON.stringify({ dependencies: { next: "^16.4.1" }, devDependencies: { "eslint-config-next": "16.3.8" } }), "apps/web/package.json in acme-shop already allows"],
    ];
    for (const [row, pkg, want] of cases) {
      h.current = fakeDb([[writeAcc], [mono], [row]]);
      const g = monoGithub(pkg);
      expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch, framework: true })).toMatchObject({ ok: false, error: expect.stringContaining(want) });
      expect(g.seen.filter((s) => s.method !== "GET")).toEqual([]);
    }
  });

  it("the dependency scan's PR uses the Root Directory too; a missing package.json names it", async () => {
    h.current = fakeDb([[writeAcc], [mono], [vuln]]);
    const g = monoGithub();
    const fetch = (async (url: string, init: RequestInit) => (new URL(url).pathname.endsWith("/contents/apps/web/package.json") ? json({ message: "Not Found" }, 404) : g.fetch(url, init))) as unknown as typeof globalThis.fetch;
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch })).toEqual({ ok: false, error: "There is no package.json in apps/web." });
  });

  it("auto: the owner's severities and the same-major rule apply to the framework PR too", async () => {
    h.current = fakeDb([[writeAcc], [mono], [sec({ findings: [{ id: "GHSA-m", cve: null, summary: "", severity: "MODERATE", fixed: "16.4.1" }] })]]);
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: monoGithub().fetch, framework: true, auto: { severities: ["critical", "high"] } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("selected severity") });
    h.current = fakeDb([[writeAcc], [mono], [sec({ version: "15.5.0", findings: [{ id: "GHSA-j", cve: null, summary: "", severity: "CRITICAL", fixed: "16.0.7" }] })]]);
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: monoGithub().fetch, framework: true, auto: { severities: ["critical", "high"] } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("jumps a major version") });
  });

  it("autoBumpReady judges a framework proposal on the Next.js check", async () => {
    h.current = fakeDb([[writeAcc], [sec()]]);
    expect(await autoBumpReady(REPO, ["critical"], { appId: APP })).toEqual({ ok: true });
    h.current = fakeDb([[writeAcc], [sec({ status: "ok", findings: [] })]]);
    expect(await autoBumpReady(REPO, ["critical"], { appId: APP })).toEqual({ ok: false, why: "nothing" });
    h.current = fakeDb([[writeAcc], [vuln]]);
    expect(await autoBumpReady(REPO, ["critical"])).toEqual({ ok: true }); // the dependency scan's path is unchanged
  });
});

// Review T1 I1: two Vercel projects on one repository (Root Directories apps/web and apps/admin) each get their own PR
// for the same Next.js fix: the folder is part of the branch and of the open-PR dedupe.
describe("bumpPrAs, two apps of one repository", () => {
  const sec = { version: "16.3.8", status: "vulnerable", findings: [{ id: "GHSA-aaaa-bbbb-cccc", cve: "CVE-2026-1111", summary: "", severity: "CRITICAL", fixed: "16.4.1" }] };
  const linkIn = (dir: string, app: string) => ({ ...link, app, meta: { rootDirectory: dir }, lockfilePath: null });
  const pkg = (name: string) => JSON.stringify({ name, dependencies: { next: "^16.3.8" }, devDependencies: { "eslint-config-next": "16.3.8" } }, null, 2) + "\n";
  // GitHub as one repository: the PRs opened so far are listed (by branch for openPull, all for the open-PR list).
  function repoGithub() {
    const prs: { number: number; branch: string; title: string }[] = [];
    const heads = new Set<string>();
    const seen: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      const method = String(init.method ?? "GET");
      const body = init.body ? JSON.parse(String(init.body)) : null;
      seen.push({ url, method, body });
      const u = new URL(url);
      const p = u.pathname;
      if (method === "GET" && p === "/repos/acme/acme-shop") return json({ default_branch: "main", permissions: { push: true } });
      if (method === "GET" && p === "/repos/acme/acme-shop/git/ref/heads/main") return json({ object: { sha: SHA } });
      if (method === "GET" && p.startsWith("/repos/acme/acme-shop/git/ref/heads/")) {
        return heads.has(p.slice("/repos/acme/acme-shop/git/ref/heads/".length)) ? json({ object: { sha: "c".repeat(40) } }) : json({}, 404);
      }
      for (const dir of ["apps/web", "apps/admin"]) {
        if (p === `/repos/acme/acme-shop/contents/${dir}/package.json`) {
          if (method === "GET") return json({ sha: "b".repeat(40), encoding: "base64", content: Buffer.from(pkg(dir)).toString("base64") });
          if (method === "PUT") return json({}, 200);
        }
      }
      if (method === "GET" && p === "/repos/acme/acme-shop/pulls") {
        const head = u.searchParams.get("head");
        const list = prs.filter((x) => !head || head === `acme:${x.branch}`)
          .map((x) => ({ number: x.number, html_url: `https://github.com/acme/acme-shop/pull/${x.number}`, title: x.title, head: { ref: x.branch, sha: "c".repeat(40), repo: { full_name: "acme/acme-shop" } }, base: { ref: "main" } }));
        return json(list);
      }
      if (method === "POST" && p === "/repos/acme/acme-shop/git/refs") { heads.add(String(body?.ref).replace("refs/heads/", "")); return json({}, 201); }
      if (method === "POST" && p === "/repos/acme/acme-shop/pulls") {
        const n = 21 + prs.length;
        prs.push({ number: n, branch: String(body?.head), title: String(body?.title) });
        return json({ number: n, html_url: `https://github.com/acme/acme-shop/pull/${n}` }, 201);
      }
      return json({}, 500);
    }) as unknown as typeof globalThis.fetch;
    return { fetch, seen, prs };
  }

  it("the same target in apps/web and apps/admin → two PRs, each editing its own package.json", async () => {
    const g = repoGithub();
    h.current = fakeDb([[writeAcc], [linkIn("apps/web", "web")], [sec]], [[]]);
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch, framework: true })).toMatchObject({ ok: true, message: expect.stringContaining("Pull request #21 opened for web") });
    // admin: #21 is open for the same packages, but in apps/web (its stored packages are read like any of ours)
    h.current = fakeDb([[writeAcc], [linkIn("apps/admin", "admin")], [sec], [{ number: 21, packages: ["next", "eslint-config-next"] }]], [[]]);
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch, framework: true })).toMatchObject({ ok: true, message: expect.stringContaining("Pull request #22 opened for admin") });
    expect(g.prs.map((p) => p.title)).toEqual(["Watchbell: update next to 16.4.1 in apps/web (security fix)", "Watchbell: update next to 16.4.1 in apps/admin (security fix)"]);
    expect(new Set(g.prs.map((p) => p.branch)).size).toBe(2);
    expect(g.seen.filter((s) => s.method === "PUT").map((s) => [new URL(s.url).pathname, s.body?.branch])).toEqual([
      ["/repos/acme/acme-shop/contents/apps/web/package.json", g.prs[0].branch],
      ["/repos/acme/acme-shop/contents/apps/admin/package.json", g.prs[1].branch],
    ]);
  });

  it("asking again for the same folder answers with its open PR; an open PR of the same folder for the package refuses", async () => {
    const g = repoGithub();
    h.current = fakeDb([[writeAcc], [linkIn("apps/web", "web")], [sec]], [[]]);
    await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch, framework: true });
    h.current = fakeDb([[writeAcc], [linkIn("apps/web", "web")], [sec]]);
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch, framework: true })).toEqual({ ok: true, message: "Pull request #21 for these updates is already open." });
    // a different target (other bumps → other branch) in the same folder: the open #21 already covers next there
    h.current = fakeDb([[writeAcc], [linkIn("apps/web", "web")], [{ ...sec, findings: [{ ...sec.findings[0], fixed: "16.4.2" }] }], [{ number: 21, packages: ["next", "eslint-config-next"] }]]);
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch, framework: true })).toMatchObject({ ok: false, error: expect.stringContaining("Pull request #21 for the same package is already open") });
    expect(g.prs).toHaveLength(1);
  });
});

// Review T1 minor 4: a Root Directory Vercel has but Watchbell can't use isn't silently the root.
describe("bumpPrAs, an unusable Root Directory", () => {
  it("refuses and names it; nothing read from GitHub", async () => {
    h.current = fakeDb([[writeAcc], [{ ...link, meta: { rootDirectory: null, rootDirectoryUnsupported: "my app" } }]]);
    const g = github();
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch, framework: true }))
      .toEqual({ ok: false, error: "The Vercel Root Directory \"my app\" of acme-shop couldn't be used (Watchbell reads plain folder names, at most 4 deep). Update its package.json yourself." });
    expect(g.seen).toEqual([]);
  });
});

// Review T1 minor 8: the dependency scan's PR that updates next updates eslint-config-next with it.
describe("bumpPrAs, eslint-config-next follows next", () => {
  const withEslint = JSON.stringify({ name: "acme-shop", dependencies: { next: "^15.0.0" }, devDependencies: { "eslint-config-next": "15.0.0" } }, null, 2) + "\n";
  const eslintGithub = () => {
    const g = github();
    const fetch = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      if (String(init.method ?? "GET") === "GET" && u.pathname === "/repos/acme/acme-shop/contents/package.json") {
        g.seen.push({ url, method: "GET", body: null });
        return json({ sha: "b".repeat(40), encoding: "base64", content: Buffer.from(withEslint).toString("base64") });
      }
      if (String(init.method ?? "GET") === "GET" && u.pathname.startsWith("/repos/acme/acme-shop/git/ref/heads/watchpost") && g.seen.some((s) => s.method === "POST" && s.url.endsWith("/pulls"))) {
        return json({ object: { sha: "c".repeat(40) } });
      }
      return g.fetch(url, init);
    }) as unknown as typeof globalThis.fetch;
    return { fetch, seen: g.seen };
  };

  it("bumps eslint-config-next to next's fixed version and records both packages", async () => {
    const f = fakeDb([[writeAcc], [link], [vuln]], [[]]);
    h.current = f;
    const g = eslintGithub();
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: g.fetch })).toMatchObject({ ok: true, message: expect.stringContaining("next ^15.0.0 → ^15.2.3, eslint-config-next 15.0.0 → 15.2.3") });
    const put = g.seen.find((s) => s.method === "PUT")!;
    expect(JSON.parse(Buffer.from(String(put.body?.content), "base64").toString()).devDependencies).toEqual({ "eslint-config-next": "15.2.3" });
    expect(g.seen.find((s) => s.method === "POST" && s.url.endsWith("/pulls"))?.body).toMatchObject({ title: "Watchbell: update next to 15.2.3 (security fix)" });
    expect(f.writes[0].calls.find((c) => c.method === "values")?.args[0]).toMatchObject({ packages: ["next", "eslint-config-next"] });
  });

  it("an automatic PR carries it too (it isn't judged as a vulnerable package)", async () => {
    h.current = fakeDb([[writeAcc], [link], [vuln]], [[]]);
    expect(await bumpPrAs(actor, APP, REPO, finisher().fin, { fetch: eslintGithub().fetch, auto: { severities: ["critical"] } }))
      .toMatchObject({ ok: true, message: expect.stringContaining("eslint-config-next 15.0.0 → 15.2.3") });
  });
});

describe("frameworkFixes (proposal facts)", () => {
  const APP2 = "55555555-5555-4555-8555-555555555555";
  const REPO2 = "66666666-6666-4666-8666-666666666666";
  const row = (appId: string, repoId: string, o: Record<string, unknown> = {}) => ({
    appId, repoId, version: "16.3.8", status: "vulnerable", findings: [{ id: "GHSA-a", cve: null, summary: "", severity: "CRITICAL", fixed: "16.4.1" }], ...o,
  });

  it("linked, vulnerable apps with a fixed version → their repository and the versions", async () => {
    const f = fakeDb([[row(APP, REPO), row(APP2, REPO2, { findings: [{ id: "GHSA-b", cve: null, summary: "", severity: "HIGH", fixed: null }] })]]);
    h.current = f;
    expect(await frameworkFixes([APP, APP2, "nope"])).toEqual(new Map([[APP, { repoId: REPO, from: "16.3.8", to: "16.4.1" }]]));
    expect(f.queries).toHaveLength(1);
  });

  it("no proposal when a firing VulnerableDependency of the same app already updates next (no second approval)", async () => {
    h.current = fakeDb([[row(APP, REPO), row(APP2, REPO2)], [{ repoId: REPO }]]);
    expect(await frameworkFixes([APP, APP2], [APP, APP2])).toEqual(new Map([[APP2, { repoId: REPO2, from: "16.3.8", to: "16.4.1" }]]));
  });

  it("nothing read for no apps; nothing without a linked repository (no row)", async () => {
    h.current = fakeDb([]);
    expect(await frameworkFixes([])).toEqual(new Map());
    h.current = fakeDb([[]]);
    expect(await frameworkFixes([APP])).toEqual(new Map());
  });
});
