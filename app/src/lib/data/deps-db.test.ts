import { beforeEach, describe, expect, it, vi } from "vitest";
import { dependencyScans, dependencyVulns } from "@/db/schema";
import { fakeDb, payloadOf } from "@/lib/data/fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64") }) }));

import { seal } from "@/lib/crypto";
import { depsDailyStep, MIN_REPO_MS, runDepsScan, scanRepo } from "./deps-db";

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
    expect(await runDepsScan(Date.now() + MIN_REPO_MS - 500, { fetch: n.fetch })).toEqual({ scanned: 0, unchanged: 0, failed: [], left: 2 });
    expect(n.seen).toEqual([]);
  });

  it("does nothing without a GitHub connection, and says so when there's no time", async () => {
    h.current = fakeDb([[]]);
    expect(await depsDailyStep(Date.now() + 30_000)).toBeNull();
    h.current = fakeDb([[{ id: "acc-1" }]]);
    expect(await depsDailyStep(Date.now() + 1_000)).toBeNull(); // waits for the next run: not a failure of the daily job
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
