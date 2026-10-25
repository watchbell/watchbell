import { beforeEach, describe, expect, it, vi } from "vitest";
import { dependencyScans, dependencyVulns } from "@/db/schema";
import { fakeDb, payloadOf } from "@/lib/data/fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64") }) }));

import { seal } from "@/lib/crypto";
import { depsDailyStep, depsSecurityStep, fixableApps, MIN_REPO_MS, reposToScan, runDepsScan, scanAppNow, scanDirs, scanRepo } from "./deps-db";

const REPO = { id: "33333333-3333-4333-8333-333333333333", fullName: "acme/acme-shop", defaultBranch: "main", scannedAt: null };
const LOCK_SHA = "1".repeat(40);
const PKG_SHA = "2".repeat(40);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const lockfile = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/next": { version: "15.0.0" }, "node_modules/vite": { version: "5.0.0", dev: true } } });

function net(over: { osv?: () => Response; dependabot?: () => Response } = {}) {
  const seen: { url: string; method: string }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const method = String(init.method ?? "GET");
    seen.push({ url, method });
    const u = new URL(url);
    if (u.hostname === "api.github.com") {
      if (u.pathname.endsWith("/contents/")) return json([{ name: "package.json", type: "file", sha: PKG_SHA, size: 100 }, { name: "package-lock.json", type: "file", sha: LOCK_SHA, size: 1000 }]);
      if (u.pathname.endsWith("/contents/package.json")) return new Response(JSON.stringify({ dependencies: { next: "^15.0.0" }, devDependencies: { vite: "^5.0.0" } }), { status: 200 });
      if (u.pathname.endsWith("/contents/package-lock.json")) return new Response(lockfile, { status: 200 });
      if (u.pathname.endsWith("/dependabot/alerts")) return over.dependabot?.() ?? json({ message: "Resource not accessible" }, 403);
    }
    if (url === "https://api.osv.dev/v1/querybatch") return over.osv?.() ?? json({ results: [{ vulns: [{ id: "GHSA-f82v-jwr5-mffw" }] }, {}] });
    if (url.startsWith("https://api.osv.dev/v1/vulns/")) {
      return json({ id: "GHSA-f82v-jwr5-mffw", aliases: ["CVE-2025-29927"], summary: "Authorization bypass in Next.js middleware", database_specific: { severity: "CRITICAL" },
        affected: [{ package: { name: "next", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "15.0.0" }, { fixed: "15.2.3" }] }] }] });
    }
    return json({}, 500);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

beforeEach(() => { h.current = null; });

describe("scanRepo", () => {
  it("an unchanged lockfile (same SHA, queried this week) costs one GitHub GET and no OSV query", async () => {
    const f = fakeDb([[{ repoId: REPO.id, lockfileSha: LOCK_SHA, scannedAt: new Date(), queriedAt: new Date(), error: null }]]);
    h.current = f;
    const n = net();
    expect(await scanRepo("github_pat_TEST", REPO, Date.now() + 30_000, { fetch: n.fetch })).toEqual({ status: "unchanged" });
    expect(n.seen).toEqual([{ url: "https://api.github.com/repos/acme/acme-shop/contents/?ref=main", method: "GET" }]);
    expect(f.writes).toEqual([]);
  });

  it("a new lockfile: reads it, queries OSV, stores the advisory with its fix and the scan's SHA; GitHub is only read", async () => {
    const f = fakeDb([[], []]);
    h.current = f;
    const n = net();
    const r = await scanRepo("github_pat_TEST", REPO, Date.now() + 30_000, { fetch: n.fetch });
    expect(r).toMatchObject({ status: "scanned", packages: 2 });
    expect(n.seen.filter((s) => s.url.startsWith("https://api.github.com")).every((s) => s.method === "GET")).toBe(true);
    const insert = f.writes.find((w) => w.kind === "insert" && w.table === dependencyVulns)!;
    expect(payloadOf(insert.calls)).toEqual([expect.objectContaining({
      repoId: REPO.id, package: "next", installedVersion: "15.0.0", vulnId: "GHSA-f82v-jwr5-mffw", aliases: ["CVE-2025-29927"], severity: "critical",
      fixedVersion: "15.2.3", direct: true, dev: false, source: "osv",
    })]);
    const scan = f.writes.find((w) => w.kind === "insert" && w.table === dependencyScans)!;
    expect(payloadOf(scan.calls)).toMatchObject({ lockfilePath: "package-lock.json", lockfileSha: LOCK_SHA, packageCount: 2, error: null });
    expect(String(payloadOf(scan.calls)?.note)).toContain("Dependabot alerts aren't readable");
  });

  it("an OSV failure records the error and changes no advisory row (fail closed)", async () => {
    const f = fakeDb([[]]);
    h.current = f;
    const n = net({ osv: () => json({}, 503) });
    expect(await scanRepo("github_pat_TEST", REPO, Date.now() + 30_000, { fetch: n.fetch })).toEqual({ status: "failed", error: "OSV.dev answered HTTP 503" });
    expect(f.writes.map((w) => w.table)).toEqual([dependencyScans]);
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ error: "OSV.dev answered HTTP 503" });
    expect(payloadOf(f.writes[0].calls)).not.toHaveProperty("lockfileSha");
  });

  it("resolves the rows a new scan no longer finds", async () => {
    const f = fakeDb([[], [{ id: "row-old", package: "lodash", installedVersion: "4.17.20", vulnId: "GHSA-lo", severity: "high", fixedVersion: "4.17.21", summary: "", aliases: [], dev: false, direct: true }]]);
    h.current = f;
    await scanRepo("github_pat_TEST", REPO, Date.now() + 30_000, { fetch: net().fetch });
    const resolve = f.writes.find((w) => w.kind === "update" && w.table === dependencyVulns && "resolvedAt" in (payloadOf(w.calls) ?? {}));
    expect(resolve).toBeDefined();
  });
});

describe("the daily step's time budget", () => {
  const key = Buffer.alloc(32, 4).toString("base64");
  const sealed = seal("github_pat_TESTONLY_0123456789abcdef", key);
  const acc = { id: "acc-1", provider: "github", credentialCiphertext: sealed.ciphertext, credentialIv: sealed.iv };

  it("starts no repository with less than MIN_REPO_MS left; the rest wait for the next run (oldest scan first)", async () => {
    const repos = [{ ...REPO, scannedAt: new Date("2026-10-10T00:00:00Z") }, { ...REPO, id: "44444444-4444-4444-8444-444444444444", scannedAt: null }];
    h.current = fakeDb([[acc], [], repos]);
    const n = net();
    expect(await runDepsScan(Date.now() + MIN_REPO_MS - 500, { fetch: n.fetch })).toEqual({ scanned: 0, unchanged: 0, failed: [], left: 2, done: [], listed: [repos[1].id, REPO.id] });
    expect(n.seen).toEqual([]);
  });

  it("does nothing without a GitHub connection, and says so when there's no time", async () => {
    h.current = fakeDb([[]]);
    expect(await depsDailyStep(Date.now() + 30_000)).toBeNull();
    h.current = fakeDb([[{ id: "acc-1" }]]);
    expect(await depsDailyStep(Date.now() + 1_000)).toBeNull(); // waits for the next run: not a failure of the daily job
  });
});

// Watchbell 1.2.1: the collector's 6-hourly `security` task scans the repositories of the apps marked after a production
// deploy first (an early run: only those), and tells which marked apps are done, so each deployment is checked once.
describe("the security task's dependency part", () => {
  const key = Buffer.alloc(32, 4).toString("base64");
  const sealed = seal("github_pat_TESTONLY_0123456789abcdef", key);
  const acc = { id: "acc-1", provider: "github", credentialCiphertext: sealed.ciphertext, credentialIv: sealed.iv };
  const APP = "22222222-2222-4222-8222-222222222222";
  const R2 = { ...REPO, id: "44444444-4444-4444-8444-444444444444", fullName: "acme/other", scannedAt: null };
  const unchangedRow = [{ repoId: REPO.id, lockfileSha: LOCK_SHA, scannedAt: new Date(), queriedAt: new Date(), error: null }];

  it("runDepsScan: `first` leads, `only` filters; every repository tried is done", async () => {
    const old = { ...REPO, scannedAt: new Date("2026-10-10T00:00:00Z") };
    h.current = fakeDb([[acc], [], [old, R2]]);
    expect(await runDepsScan(Date.now() + MIN_REPO_MS - 500, { first: [REPO.id] })).toMatchObject({ listed: [REPO.id, R2.id], left: 2 });
    h.current = fakeDb([[acc], [], [old, R2], [], unchangedRow]);
    const n = net();
    expect(await runDepsScan(Date.now() + 30_000, { fetch: n.fetch, only: [REPO.id] })).toEqual({ scanned: 0, unchanged: 1, failed: [], left: 0, done: [REPO.id], listed: [REPO.id] });
    h.current = fakeDb([[acc], [], [old, R2]]);
    expect(await runDepsScan(Date.now() + MIN_REPO_MS - 500, { skip: [REPO.id] })).toMatchObject({ listed: [R2.id] });
    expect(n.seen).toHaveLength(1); // the unchanged lockfile: one GitHub GET, no OSV query
  });

  // Fix round 1: the 6-hourly slot continues over several minute runs; repositories it already tried are left out, except
  // those of a marked app, and `complete` says whether nothing is left.
  it("a slot run skips the repositories already tried (not a marked one) and says whether anything is left", async () => {
    h.current = fakeDb([[{ id: "acc-1" }], [acc], [], [REPO, R2], [], unchangedRow]);
    const n = net();
    expect(await depsSecurityStep(Date.now() + 30_000, { marked: [], onlyMarked: false, skip: [R2.id] }, { fetch: n.fetch })).toEqual({ problem: null, settled: [], done: [REPO.id], complete: true });
    // A marked app's repository is scanned even when this slot tried it before (before the deploy).
    h.current = fakeDb([[{ id: "acc-1" }], [{ appId: APP, repoId: REPO.id }], [acc], [], [REPO, R2], [], unchangedRow]);
    expect(await depsSecurityStep(Date.now() + 30_000, { marked: [APP], onlyMarked: false, skip: [REPO.id, R2.id] }, { fetch: net().fetch }))
      .toEqual({ problem: null, settled: [APP], done: [REPO.id], complete: true });
  });

  it("no GitHub connection: nothing is scanned and the marks are done", async () => {
    const f = fakeDb([[]]);
    h.current = f;
    expect(await depsSecurityStep(Date.now() + 30_000, { marked: [APP], onlyMarked: true })).toEqual({ problem: null, settled: [APP], done: [], complete: true });
    expect(f.queries).toHaveLength(1);
  });

  it("an early run scans only the marked app's repository; the app is done once it was tried", async () => {
    h.current = fakeDb([[{ id: "acc-1" }], [{ appId: APP, repoId: REPO.id }], [acc], [], [REPO, R2], [], unchangedRow]);
    const n = net();
    expect(await depsSecurityStep(Date.now() + 30_000, { marked: [APP], onlyMarked: true }, { fetch: n.fetch })).toEqual({ problem: null, settled: [APP], done: [REPO.id], complete: true });
    expect(n.seen.map((s) => s.url)).toEqual(["https://api.github.com/repos/acme/acme-shop/contents/?ref=main"]);
  });

  it("a marked app without a linked repository has nothing to scan: done at once, no scan on an early run", async () => {
    const f = fakeDb([[{ id: "acc-1" }], []]);
    h.current = f;
    expect(await depsSecurityStep(Date.now() + 30_000, { marked: [APP], onlyMarked: true })).toEqual({ problem: null, settled: [APP], done: [], complete: true });
    expect(f.queries).toHaveLength(2);
  });

  it("no time left: the marked app waits for the next run", async () => {
    h.current = fakeDb([[{ id: "acc-1" }], [{ appId: APP, repoId: REPO.id }]]);
    expect(await depsSecurityStep(Date.now() + 1_000, { marked: [APP], onlyMarked: true })).toEqual({ problem: null, settled: [], done: [], complete: false });
  });

  it("an unreadable GitHub credential is reported once: the marks are done", async () => {
    h.current = fakeDb([[{ id: "acc-1" }], [{ appId: APP, repoId: REPO.id }], [{ ...acc, credentialIv: "bad" }]]);
    const r = await depsSecurityStep(Date.now() + 30_000, { marked: [APP], onlyMarked: true });
    expect(r.settled).toEqual([APP]);
    expect(r.problem).toMatch(/credential/);
  });
});

describe("isDeferral", () => {
  it("treats slow or rate-limited repositories as deferred, not failed", async () => {
    const { isDeferral } = await import("./deps-db");
    expect(isDeferral("Acme/orbit-notes: OSV.dev didn't answer in time")).toBe(true);
    expect(isDeferral("20 repositories left for the next run, time budget used")).toBe(true);
    expect(isDeferral("GitHub's rate limit is used up for now")).toBe(true);
    expect(isDeferral("Acme/beacon-app: No time left for OSV.dev")).toBe(true);
    expect(isDeferral("Acme/x: GitHub rejected the token (401)")).toBe(false);
  });
});

// Watchbell 1.2.1 (fix round 1): the scan reads the branch Vercel deploys to production when the repository has it, so
// the advisories come from what is live (shopfront: web-revamp, while main is stale); otherwise the default branch.
describe("scanRepo on the production branch", () => {
  const PROD = { ...REPO, prodBranch: "web-revamp" };
  const onProd = (exists: boolean | "error") => {
    const n = net();
    const fetch = (async (url: string, init: RequestInit) => {
      if (new URL(url).pathname === "/repos/acme/acme-shop/git/ref/heads/web-revamp") {
        n.seen.push({ url, method: "GET" });
        return exists === "error" ? json({}, 502) : exists ? json({ object: { sha: "9".repeat(40) } }) : json({ message: "Not Found" }, 404);
      }
      return n.fetch(url, init);
    }) as unknown as typeof globalThis.fetch;
    return { fetch, seen: n.seen };
  };

  it("the production branch exists: its files are read, and the scan key names the branch", async () => {
    const f = fakeDb([[], []]);
    h.current = f;
    const n = onProd(true);
    expect(await scanRepo("github_pat_TEST", PROD, Date.now() + 30_000, { fetch: n.fetch })).toMatchObject({ status: "scanned" });
    const gets = n.seen.filter((s) => s.url.startsWith("https://api.github.com/repos/acme/acme-shop/contents")).map((s) => new URL(s.url).searchParams.get("ref"));
    expect(new Set(gets)).toEqual(new Set(["web-revamp"]));
    const scan = payloadOf(f.writes.find((w) => w.kind === "insert" && w.table === dependencyScans)!.calls);
    expect(scan).toMatchObject({ lockfileSha: `br:web-revamp:${LOCK_SHA}` });
    expect(String(scan?.note)).toContain("web-revamp");
  });

  it("a stored scan of the default branch is scanned again once the production branch is used (the key changed)", async () => {
    const f = fakeDb([[{ repoId: REPO.id, lockfileSha: LOCK_SHA, scannedAt: new Date(), queriedAt: new Date(), error: null }], []]);
    h.current = f;
    expect(await scanRepo("github_pat_TEST", PROD, Date.now() + 30_000, { fetch: onProd(true).fetch })).toMatchObject({ status: "scanned" });
    const g = fakeDb([[{ repoId: REPO.id, lockfileSha: `br:web-revamp:${LOCK_SHA}`, scannedAt: new Date(), queriedAt: new Date(), error: null }]]);
    h.current = g;
    expect(await scanRepo("github_pat_TEST", PROD, Date.now() + 30_000, { fetch: onProd(true).fetch })).toEqual({ status: "unchanged" });
  });

  it("the production branch isn't in the repository: the default branch, with the key it always had", async () => {
    const f = fakeDb([[{ repoId: REPO.id, lockfileSha: LOCK_SHA, scannedAt: new Date(), queriedAt: new Date(), error: null }]]);
    h.current = f;
    const n = onProd(false);
    expect(await scanRepo("github_pat_TEST", PROD, Date.now() + 30_000, { fetch: n.fetch })).toEqual({ status: "unchanged" });
    expect(n.seen.map((s) => s.url)).toContain("https://api.github.com/repos/acme/acme-shop/contents/?ref=main");
  });

  it("GitHub can't say whether the branch exists: the scan fails (retried), it doesn't guess", async () => {
    const f = fakeDb([]);
    h.current = f;
    expect(await scanRepo("github_pat_TEST", PROD, Date.now() + 30_000, { fetch: onProd("error").fetch })).toMatchObject({ status: "failed" });
  });
});

// Watchbell 1.2 (owner 23 Oct): a monorepo (Vercel Root Directory "apps/web") is scanned in that folder.
describe("scanRepo in the app's Root Directory", () => {
  const WEB_LOCK = "3".repeat(40);
  const ROOT_LOCK = "4".repeat(40);
  function mono(o: { webLock?: boolean; folder?: boolean; rootPkg?: unknown; rootLock?: string } = {}) {
    const seen: string[] = [];
    const fetch = (async (url: string) => {
      seen.push(url);
      const u = new URL(url);
      if (u.hostname === "api.github.com") {
        if (u.pathname === "/repos/acme/acme-shop/contents/apps/web") {
          if (o.folder === false) return json({ message: "Not Found" }, 404);
          return json([{ name: "package.json", type: "file", sha: PKG_SHA, size: 100 }, ...(o.webLock !== false ? [{ name: "package-lock.json", type: "file", sha: WEB_LOCK, size: 1000 }] : [])]);
        }
        if (u.pathname === "/repos/acme/acme-shop/contents/") return json([{ name: "package.json", type: "file", sha: "5".repeat(40), size: 50 }, { name: "package-lock.json", type: "file", sha: ROOT_LOCK, size: 1000 }]);
        if (u.pathname === "/repos/acme/acme-shop/contents/apps/web/package.json") return new Response(JSON.stringify({ dependencies: { next: "^15.0.0" } }), { status: 200 });
        if (u.pathname === "/repos/acme/acme-shop/contents/package.json" && o.rootPkg !== undefined) return new Response(JSON.stringify(o.rootPkg), { status: 200 });
        if (u.pathname === "/repos/acme/acme-shop/contents/package-lock.json" && o.rootLock !== undefined) return new Response(o.rootLock, { status: 200 });
        if (u.pathname.endsWith("/package-lock.json")) return new Response(lockfile, { status: 200 });
        if (u.pathname.endsWith("/dependabot/alerts")) return json({ message: "Resource not accessible" }, 403);
      }
      if (url === "https://api.osv.dev/v1/querybatch") return json({ results: [{}, {}] });
      return json({}, 500);
    }) as unknown as typeof globalThis.fetch;
    return { fetch, seen };
  }
  const scanWrite = (f: ReturnType<typeof fakeDb>) => payloadOf(f.writes.find((w) => w.kind === "insert" && w.table === dependencyScans)!.calls);

  it("lists, reads and records apps/web's package.json and lockfile (the card shows apps/web/package-lock.json)", async () => {
    const f = fakeDb([[], []]);
    h.current = f;
    const n = mono();
    expect(await scanRepo("github_pat_TEST", { ...REPO, rootDir: "apps/web" }, Date.now() + 30_000, { fetch: n.fetch })).toMatchObject({ status: "scanned", packages: 2 });
    expect(n.seen.filter((u) => u.startsWith("https://api.github.com/repos/acme/acme-shop/contents"))).toEqual([
      "https://api.github.com/repos/acme/acme-shop/contents/apps/web?ref=main",
      "https://api.github.com/repos/acme/acme-shop/contents/apps/web/package.json?ref=main",
      "https://api.github.com/repos/acme/acme-shop/contents/apps/web/package-lock.json?ref=main",
    ]);
    expect(scanWrite(f)).toMatchObject({ lockfilePath: "apps/web/package-lock.json", lockfileSha: `apps/web:${WEB_LOCK}`, packageCount: 2 });
    expect(String(scanWrite(f)?.note)).not.toContain("Scanned");
  });

  it("a workspace without a lockfile in the folder uses the repository root's, and says so", async () => {
    const f = fakeDb([[], []]);
    h.current = f;
    const n = mono({ webLock: false, rootPkg: { name: "root", private: true, workspaces: ["apps/*"] } });
    expect(await scanRepo("github_pat_TEST", { ...REPO, rootDir: "apps/web" }, Date.now() + 30_000, { fetch: n.fetch })).toMatchObject({ status: "scanned" });
    expect(n.seen).toContain("https://api.github.com/repos/acme/acme-shop/contents/?ref=main");
    expect(n.seen).toContain("https://api.github.com/repos/acme/acme-shop/contents/package-lock.json?ref=main");
    expect(scanWrite(f)).toMatchObject({
      lockfilePath: "package-lock.json", lockfileSha: `apps/web:${ROOT_LOCK}+${PKG_SHA}`,
      note: expect.stringMatching(/^Scanned apps\/web \(the Vercel project's Root Directory\) with the repository root's package-lock\.json \(workspaces\)\./),
    });
  });

  it("a Root Directory that isn't in the repository is a failed scan naming it; nothing else is read", async () => {
    const f = fakeDb([]);
    h.current = f;
    const n = mono({ folder: false });
    expect(await scanRepo("github_pat_TEST", { ...REPO, rootDir: "apps/web" }, Date.now() + 30_000, { fetch: n.fetch }))
      .toEqual({ status: "failed", error: "The folder apps/web (the Vercel project's Root Directory) isn't in acme/acme-shop on main." });
    expect(n.seen).toHaveLength(1);
  });

  it("an unsafe Root Directory falls back to the root", async () => {
    h.current = fakeDb([[{ repoId: REPO.id, lockfileSha: LOCK_SHA, scannedAt: new Date(), queriedAt: new Date(), error: null }]]);
    const n = net();
    expect(await scanRepo("github_pat_TEST", { ...REPO, rootDir: "../other" }, Date.now() + 30_000, { fetch: n.fetch })).toEqual({ status: "unchanged" });
    expect(n.seen).toEqual([{ url: "https://api.github.com/repos/acme/acme-shop/contents/?ref=main", method: "GET" }]);
  });
});

// Review T1 minor 2: the root's lockfile stands in only when the root is a workspace that includes the folder.
describe("scanRepo, the root lockfile only for a real workspace", () => {
  const WEB_PKG = "2".repeat(40);
  function tree(o: { rootPkg?: unknown; rootLock?: string }) {
    const seen: string[] = [];
    const fetch = (async (url: string) => {
      seen.push(url);
      const u = new URL(url);
      if (u.pathname === "/repos/acme/acme-shop/contents/apps/web") return json([{ name: "package.json", type: "file", sha: WEB_PKG, size: 100 }]);
      if (u.pathname === "/repos/acme/acme-shop/contents/") return json([{ name: "package.json", type: "file", sha: "5".repeat(40), size: 50 }, { name: "package-lock.json", type: "file", sha: "4".repeat(40), size: 1000 }]);
      if (u.pathname === "/repos/acme/acme-shop/contents/apps/web/package.json") return new Response(JSON.stringify({ dependencies: { next: "^16.3.8" } }), { status: 200 });
      if (u.pathname === "/repos/acme/acme-shop/contents/package.json") return new Response(JSON.stringify(o.rootPkg ?? {}), { status: 200 });
      if (u.pathname === "/repos/acme/acme-shop/contents/package-lock.json") return new Response(o.rootLock ?? lockfile, { status: 200 });
      if (u.pathname.endsWith("/dependabot/alerts")) return json({ message: "Resource not accessible" }, 403);
      if (url === "https://api.osv.dev/v1/querybatch") return json({ results: [{}] });
      return json({}, 500);
    }) as unknown as typeof globalThis.fetch;
    return { fetch, seen };
  }
  const scanWrite = (f: ReturnType<typeof fakeDb>) => payloadOf(f.writes.find((w) => w.kind === "insert" && w.table === dependencyScans)!.calls);

  it("a root package.json that isn't a workspace (Firebase functions): the folder's package.json ranges, with a note", async () => {
    const f = fakeDb([[], []]);
    h.current = f;
    const n = tree({ rootPkg: { name: "functions", dependencies: { "firebase-admin": "^12.0.0" } } });
    expect(await scanRepo("github_pat_TEST", { ...REPO, rootDir: "apps/web" }, Date.now() + 30_000, { fetch: n.fetch })).toMatchObject({ status: "scanned", packages: 1 });
    expect(scanWrite(f)).toMatchObject({
      lockfilePath: "apps/web/package.json", packageCount: 1,
      note: expect.stringMatching(/^The repository root's package-lock\.json isn't a workspace that includes apps\/web, so the versions come from apps\/web\/package\.json ranges \(approximate\)\./),
    });
    expect(String(scanWrite(f)?.note)).not.toContain("(workspaces)");
  });

  it("an npm lockfile that lists the folder is enough (the root package.json isn't read)", async () => {
    const f = fakeDb([[], []]);
    h.current = f;
    const ws = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "apps/web": { name: "web" }, "node_modules/next": { version: "16.3.8" } } });
    const n = tree({ rootLock: ws });
    expect(await scanRepo("github_pat_TEST", { ...REPO, rootDir: "apps/web" }, Date.now() + 30_000, { fetch: n.fetch })).toMatchObject({ status: "scanned" });
    expect(scanWrite(f)).toMatchObject({ lockfilePath: "package-lock.json", note: expect.stringContaining("(workspaces)") });
    expect(n.seen).not.toContain("https://api.github.com/repos/acme/acme-shop/contents/package.json?ref=main");
  });
});

// Review T1 minor 4: an unusable Root Directory is scanned at the root, and the card says why.
describe("scanRepo, an unusable Root Directory", () => {
  it("scans the root and notes that the Root Directory couldn't be used", async () => {
    const f = fakeDb([[], []]);
    h.current = f;
    const r = await scanRepo("github_pat_TEST", { ...REPO, rootDir: null, rootDirUnsupported: "my app" }, Date.now() + 30_000, { fetch: net().fetch });
    expect(r).toMatchObject({ status: "scanned" });
    const scan = payloadOf(f.writes.find((w) => w.kind === "insert" && w.table === dependencyScans)!.calls);
    expect(scan).toMatchObject({ lockfilePath: "package-lock.json", lockfileSha: `odd:${LOCK_SHA}` });
    expect(String(scan?.note)).toMatch(/^The Vercel Root Directory "my app" couldn't be used \(Watchbell reads plain folder names, at most 4 deep\); scanned the repository root\./);
  });
});

describe("scanDirs / reposToScan", () => {
  it("each repository's folder is its linked app's Root Directory (a watched app first, then by name)", async () => {
    const R2 = "44444444-4444-4444-8444-444444444444";
    const R3 = "55555555-5555-4555-8555-555555555555";
    h.current = fakeDb([[
      { repoId: REPO.id, name: "web-b", monitored: true, meta: { rootDirectory: "apps/b" } },
      { repoId: REPO.id, name: "web-a", monitored: false, meta: { rootDirectory: "apps/web" } },
      { repoId: R2, name: "solo", monitored: true, meta: {} },
      { repoId: R3, name: "odd", monitored: true, meta: { rootDirectory: null, rootDirectoryUnsupported: "my app" } },
      { repoId: R3, name: "a-unwatched", monitored: false, meta: { rootDirectory: "apps/x" } },
    ]]);
    expect(await scanDirs([REPO.id, R2, R3, "nope"])).toEqual(new Map([
      [REPO.id, { dir: "apps/b", unsupported: null, branch: null }], [R2, { dir: null, unsupported: null, branch: null }], [R3, { dir: null, unsupported: "my app", branch: null }],
    ]));
  });

  it("reposToScan carries the folder and the production branch to the scan", async () => {
    h.current = fakeDb([[], [{ id: REPO.id, fullName: REPO.fullName, defaultBranch: "main", scannedAt: null }], [{ repoId: REPO.id, name: "web", monitored: true, meta: { rootDirectory: "./apps/web/", productionBranch: "web-revamp" } }]]);
    expect(await reposToScan()).toEqual([{ id: REPO.id, fullName: REPO.fullName, defaultBranch: "main", scannedAt: null, rootDir: "apps/web", rootDirUnsupported: null, prodBranch: "web-revamp" }]);
  });
});

// Review T1 minor 5: "Scan now" on an app's page scans that app's own folder.
describe("scanAppNow", () => {
  const key = Buffer.alloc(32, 4).toString("base64");
  const sealed = seal("github_pat_TESTONLY_0123456789abcdef", key);
  const acc = { id: "acc-1", provider: "github", credentialCiphertext: sealed.ciphertext, credentialIv: sealed.iv };
  it("uses the clicked app's Root Directory, not another app's of the same repository", async () => {
    const seen: string[] = [];
    const fetch = (async (url: string) => {
      seen.push(url);
      if (new URL(url).pathname === "/repos/acme/acme-shop/contents/apps/admin") return json({ message: "Not Found" }, 404);
      return json({}, 500);
    }) as unknown as typeof globalThis.fetch;
    h.current = fakeDb([[{ app: "admin", id: REPO.id, fullName: REPO.fullName, defaultBranch: "main", goneAt: null, meta: { rootDirectory: "apps/admin" } }], [acc]]);
    expect(await scanAppNow("22222222-2222-4222-8222-222222222222", { fetch })).toEqual({ ok: false, error: "The scan failed: The folder apps/admin (the Vercel project's Root Directory) isn't in acme/acme-shop on main." });
    expect(seen).toEqual(["https://api.github.com/repos/acme/acme-shop/contents/apps/admin?ref=main"]);
  });
  it("scans the clicked app's production branch when the repository has it", async () => {
    const seen: string[] = [];
    const fetch = (async (url: string) => {
      seen.push(url);
      const p = new URL(url).pathname;
      if (p === "/repos/acme/acme-shop/git/ref/heads/web-revamp") return json({ object: { sha: "9".repeat(40) } });
      if (p === "/repos/acme/acme-shop/contents/") return json({ message: "Not Found" }, 404);
      return json({}, 500);
    }) as unknown as typeof globalThis.fetch;
    h.current = fakeDb([[{ app: "shop", id: REPO.id, fullName: REPO.fullName, defaultBranch: "main", goneAt: null, meta: { productionBranch: "web-revamp" } }], [acc]]);
    await scanAppNow("22222222-2222-4222-8222-222222222222", { fetch });
    expect(seen).toContain("https://api.github.com/repos/acme/acme-shop/contents/?ref=web-revamp");
  });
});

// Review T1 minor 1: no second ask for next. The VulnerableDependency proposal leaves next out when the app already has
// a FrameworkVulnerable update-PR proposal (pending or done) or an open Watchbell PR that updates next.
describe("fixableApps", () => {
  const APP = "22222222-2222-4222-8222-222222222222";
  const APP2 = "66666666-6666-4666-8666-666666666666";
  const vulnRow = (pkg: string, o: Record<string, unknown> = {}) => ({
    repoId: REPO.id, package: pkg, installedVersion: "15.0.0", fixedVersion: "15.2.3", vulnId: `GHSA-${pkg}`, aliases: [], severity: "critical", direct: true, ...o,
  });

  it("apps whose direct packages have a fix → their repository (unchanged path)", async () => {
    const f = fakeDb([[{ appId: APP, repoId: REPO.id }], [vulnRow("next")], []]);
    h.current = f;
    expect(await fixableApps([APP])).toEqual(new Map([[APP, REPO.id]]));
  });

  it("skips next for an app the framework proposal already asked about; other packages still count", async () => {
    h.current = fakeDb([[{ appId: APP, repoId: REPO.id }], [vulnRow("next")], []]);
    expect(await fixableApps([APP], new Set([APP]))).toEqual(new Map());
    h.current = fakeDb([[{ appId: APP, repoId: REPO.id }], [vulnRow("next"), vulnRow("lodash", { installedVersion: "4.17.20", fixedVersion: "4.17.21" })], []]);
    expect(await fixableApps([APP], new Set([APP]))).toEqual(new Map([[APP, REPO.id]]));
  });

  it("skips next for an app with an open Watchbell PR that updates next (per app, not per repository)", async () => {
    const f = fakeDb([[{ appId: APP, repoId: REPO.id }, { appId: APP2, repoId: REPO.id }], [vulnRow("next")], [{ appId: APP }]]);
    h.current = f;
    expect(await fixableApps([APP, APP2])).toEqual(new Map([[APP2, REPO.id]]));
    expect(f.queries).toHaveLength(3);
  });

  it("reads no PRs when no open advisory is for next", async () => {
    const f = fakeDb([[{ appId: APP, repoId: REPO.id }], [vulnRow("lodash", { installedVersion: "4.17.20", fixedVersion: "4.17.21" })]]);
    h.current = f;
    expect(await fixableApps([APP])).toEqual(new Map([[APP, REPO.id]]));
    expect(f.queries).toHaveLength(2);
  });
});
