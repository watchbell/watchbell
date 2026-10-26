import { beforeEach, describe, expect, it, vi } from "vitest";
import { accounts, appRepos, githubRepos, settings } from "@/db/schema";
import { seal } from "@/lib/crypto";
import { fakeDb, payloadOf } from "@/lib/data/fake-db";

const key = Buffer.alloc(32, 4).toString("base64");
const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: key }) }));

import { linkAppRepo, syncGithub } from "./github-db";

const ACC = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const sealed = seal("github_pat_TESTONLY_0123456789abcdef", key);
const account = { id: ACC, provider: "github", label: "GitHub", credentialCiphertext: sealed.ciphertext, credentialIv: sealed.iv, status: "ok", lastError: null };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function github(over: Partial<Record<"repos" | "pkg" | "runs" | "user", () => Response>> = {}) {
  const seen: { url: string; method: string }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: String(init.method ?? "GET") });
    const u = new URL(url);
    if (u.pathname === "/user/repos") return over.repos?.() ?? json([{ id: 7, name: "acme-shop", full_name: "acme/acme-shop", owner: { login: "acme" }, default_branch: "main", private: true, archived: false, html_url: "https://github.com/acme/acme-shop", pushed_at: "2026-10-14T00:00:00Z" }]);
    if (u.pathname.endsWith("/contents/package.json")) return over.pkg?.() ?? new Response(JSON.stringify({ name: "acme-shop" }), { status: 200 });
    if (u.pathname.endsWith("/actions/runs")) return over.runs?.() ?? json({ total_count: 1, workflow_runs: [{ status: "completed", conclusion: "success", name: "CI", head_branch: "main", head_sha: "abc", html_url: "https://github.com/acme/acme-shop/actions/runs/9", run_number: 9, updated_at: "2026-10-15T00:00:00Z" }] });
    if (u.pathname === "/user") return over.user?.() ?? json({ login: "acme" }, 200, { "github-authentication-token-expiration": "2027-01-01 00:00:00 UTC" });
    return json({}, 500);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

const storedRepo = { id: REPO, accountId: ACC, externalId: "7", owner: "acme", name: "acme-shop", fullName: "acme/acme-shop", defaultBranch: "main", private: true, archived: false, htmlUrl: null, pushedAt: new Date("2026-10-14T00:00:00Z"), packageName: null, packageCheckedAt: null, actions: null, actionsCheckedAt: null, firstSeenAt: new Date(), lastSeenAt: new Date(), goneAt: null };

beforeEach(() => { h.current = null; });

describe("syncGithub (B7)", () => {
  it("stores the repositories, reads package names, links apps from Vercel, reads Actions, and only ever GETs", async () => {
    const f = fakeDb([
      [account], // the GitHub account
      [], // stored repos before
      [storedRepo], // stored repos after the upsert
      [{ id: APP, name: "acme-shop", meta: { repo: "acme/acme-shop", repoType: "github" } }], // apps
      [], // links
      [{ id: REPO, fullName: "acme/acme-shop", defaultBranch: "main" }], // linked repos
    ]);
    h.current = f;
    const g = github();
    const r = await syncGithub(ACC, Date.now() + 10_000, { fetch: g.fetch });
    expect(r).toEqual({ ok: true, repos: 1, linked: 1, newLinks: 1, notes: [] });
    expect(g.seen.every((s) => s.method === "GET")).toBe(true);
    const inserted = f.writes.find((w) => w.kind === "insert" && w.table === githubRepos)!;
    expect(payloadOf(inserted.calls)).toEqual([expect.objectContaining({ accountId: ACC, externalId: "7", fullName: "acme/acme-shop", defaultBranch: "main" })]);
    const link = f.writes.find((w) => w.kind === "insert" && w.table === appRepos)!;
    expect(payloadOf(link.calls)).toEqual({ appId: APP, repoId: REPO, source: "vercel" });
    const updates = f.writes.filter((w) => w.kind === "update" && w.table === githubRepos).map((w) => payloadOf(w.calls));
    expect(updates).toContainEqual(expect.objectContaining({ packageName: "acme-shop" }));
    expect(updates).toContainEqual(expect.objectContaining({ actions: expect.objectContaining({ conclusion: "success", runNumber: 9 }) }));
    const acc = f.writes.filter((w) => w.kind === "update" && w.table === accounts).map((w) => payloadOf(w.calls));
    expect(acc.at(-1)).toMatchObject({ status: "ok", lastError: null, expiresAt: new Date("2027-01-01T00:00:00Z") });
  });

  it("a rejected token marks the account and keeps every stored repository", async () => {
    const f = fakeDb([[account]]);
    h.current = f;
    const r = await syncGithub(ACC, Date.now() + 10_000, { fetch: github({ repos: () => json({}, 401) }).fetch });
    expect(r).toEqual({ ok: false, error: "GitHub rejected this token (401). It may have expired or been revoked." });
    expect(f.writes.map((w) => w.table)).toEqual([accounts]);
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ status: "error" });
  });

  it("names a missing Actions permission instead of failing the sync, and keeps it for Connections (1.2.3)", async () => {
    const f = fakeDb([[account], [], [{ ...storedRepo, packageCheckedAt: new Date("2026-10-15T00:00:00Z") }], [], [], [{ id: REPO, fullName: "acme/acme-shop", defaultBranch: "main" }]]);
    h.current = f;
    const r = await syncGithub(ACC, Date.now() + 10_000, { fetch: github({ runs: () => json({ message: "Resource not accessible" }, 403) }).fetch });
    expect(r).toMatchObject({ ok: true, notes: ["Some Actions runs can't be read: give the token Actions read on those repositories."] });
    const kept = f.writes.find((w) => w.kind === "insert" && w.table === settings)!;
    expect(payloadOf(kept.calls)).toMatchObject({ key: `github.readGaps.${ACC}`, value: { actionsDenied: 1, contentsDenied: 0 } });
  });

  it("is a clear no-op without a GitHub connection", async () => {
    h.current = fakeDb([[]]);
    expect(await syncGithub(undefined, Date.now() + 1000, { fetch: github().fetch })).toEqual({ ok: false, error: "GitHub isn't connected." });
  });
});

describe("linkAppRepo (owner's choice)", () => {
  it("links manually, which a sync never overwrites", async () => {
    const f = fakeDb([[{ id: APP, name: "acme-shop" }], [{ id: REPO, fullName: "acme/acme-shop" }]]);
    h.current = f;
    expect(await linkAppRepo(APP, REPO, "user-1")).toEqual({ ok: true, message: "acme-shop is linked to acme/acme-shop.", app: "acme-shop", repo: "acme/acme-shop" });
    expect(payloadOf(f.writes[0].calls)).toEqual({ appId: APP, repoId: REPO, source: "manual", linkedBy: "user-1" });
  });
  it("unlinks, and refuses ids that aren't UUIDs or a repository that is gone", async () => {
    h.current = fakeDb([[{ id: APP, name: "acme-shop" }]], [[{ appId: APP }]]);
    expect(await linkAppRepo(APP, null, "user-1")).toMatchObject({ ok: true, message: "acme-shop is no longer linked to a repository." });
    expect(await linkAppRepo("nope", null, "user-1")).toEqual({ ok: false, error: "That app or repository no longer exists." });
    h.current = fakeDb([[{ id: APP, name: "acme-shop" }], []]);
    expect(await linkAppRepo(APP, REPO, "user-1")).toEqual({ ok: false, error: "That repository is no longer shared with the GitHub token. Sync GitHub and try again." });
  });
});

describe("githubDailyStep", () => {
  it("does nothing without a GitHub connection, and waits for tomorrow when the run is already late", async () => {
    const { githubDailyStep } = await import("./github-db");
    h.current = fakeDb([[]]);
    expect(await githubDailyStep(Date.now() + 5_000)).toBeNull();
    const f = fakeDb([[{ id: ACC }]]);
    h.current = f;
    expect(await githubDailyStep(Date.now() - 1)).toBe("left for the next run, time budget used");
    expect(f.writes).toEqual([]);
  });
});
