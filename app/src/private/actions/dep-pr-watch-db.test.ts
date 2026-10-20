import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIONS_COPY } from "@/lib/copy/edition";

vi.mock("@/db/client", () => ({ db: () => { throw new Error("no database in tests"); } }));
// The registry the watcher reads the VM runner from (private edition: r1; open source edition: none).
const ext = vi.hoisted(() => ({ extensions: { nav: [], palette: [] } as { nav: never[]; palette: never[]; runner?: { queueLockfileJob: unknown; lockfileJobActive: (r: string, b: string) => Promise<boolean> } } }));
vi.mock("@/lib/extensions", () => ext);

import { runnerLockfileActive, type WatchDeps, watchDepPrs } from "./dep-pr-watch-db";

const now = new Date("2026-10-16T10:00:00Z");
const min = (m: number) => new Date(now.getTime() - m * 60_000);
const SHA = "a".repeat(40);
const APP = "11111111-1111-4111-8111-111111111111";
const PROP = "22222222-2222-4222-8222-222222222222";
const row = (o: object = {}) => ({
  id: "pr-row", repoId: "r", appId: APP, proposalId: PROP, number: 12, branch: "watchpost/deps-0a1b2c3d", baseBranch: "main", headSha: SHA,
  title: "Watchpost: update next ke 15.0.5 (perbaikan keamanan)", packages: ["next"], auto: true, stage: "checks" as const, smokeMode: null,
  previewReadyAt: null, openedAt: min(10), fullName: "o/acme-shop", appName: "acme-shop", ...o,
});
const ok = <T>(data: T) => ({ ok: true as const, data });

function deps(o: Partial<WatchDeps> = {}): WatchDeps & { saved: { set: Record<string, unknown>; text: string }[] } {
  const saved: { set: Record<string, unknown>; text: string }[] = [];
  return {
    saved,
    rows: vi.fn().mockResolvedValue([row()]),
    security: vi.fn().mockResolvedValue({ enabled: true, severities: ["critical", "high"], sameMajorOnly: true }),
    rollback: vi.fn().mockResolvedValue({ enabled: true, windowMin: 30 }),
    writeToken: vi.fn().mockResolvedValue("w"),
    readToken: vi.fn().mockResolvedValue("r"),
    vercel: vi.fn().mockResolvedValue({ token: "v", teamId: "team", projectId: "prj" }),
    monitorUrls: vi.fn().mockResolvedValue(["https://acme-shop.example/api/health"]),
    pull: vi.fn().mockResolvedValue(ok({ state: "open", merged: false, mergeable: true, headSha: SHA, branch: "watchpost/deps-0a1b2c3d", base: "main" })),
    checks: vi.fn().mockResolvedValue(ok({ checkRuns: [{ status: "completed", conclusion: "success" }], combined: { state: "success", total: 1 } })),
    runs: vi.fn(),
    previews: vi.fn().mockResolvedValue(ok([{ id: "dpl_prev", projectId: "prj", state: "ready", rawState: "READY", target: "preview", branch: null, sha: SHA, message: null, source: "git", url: "acme-shop-git-x.vercel.app", createdAt: min(6), buildingAt: null, readyAt: min(5) }])),
    probe: vi.fn().mockResolvedValue({ status: 200, ms: 120, authWall: false }),
    errorLogs: vi.fn().mockResolvedValue(0),
    merge: vi.fn().mockResolvedValue(ok({ sha: "e".repeat(40) })),
    save: vi.fn(async (_id, set, _p, text) => { saved.push({ set: set as Record<string, unknown>, text }); }),
    notify: vi.fn().mockResolvedValue(undefined),
    audit: vi.fn().mockResolvedValue(undefined),
    book: vi.fn().mockResolvedValue({ db: [], app: [{ id: APP, name: "acme-shop", alias: "app-a" }] }),
    ...o,
  };
}
const deadline = () => Date.now() + 50_000;

beforeEach(() => vi.clearAllMocks());

describe("watchDepPrs", () => {
  it("pending → merged: green checks, READY preview, HTTP smoke ok, auto-rollback on → squash merge pinned to the SHA", async () => {
    const d = deps();
    expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 1, stopped: 0 });
    expect(d.probe).toHaveBeenCalledWith("https://acme-shop-git-x.vercel.app/");
    expect(d.probe).toHaveBeenCalledWith("https://acme-shop-git-x.vercel.app/api/health");
    expect(d.merge).toHaveBeenCalledWith("w", "o/acme-shop", 12, "watchpost/deps-0a1b2c3d", "main", SHA, "Watchpost: update next ke 15.0.5 (perbaikan keamanan)");
    expect(d.saved.map((s) => s.text)).toEqual(["PR #12: merging…", "PR #12: merged ✅"]);
    expect(d.saved[0].set).toMatchObject({ stage: "merging", smokeMode: "http" });
    expect(d.notify).toHaveBeenCalledWith({ app: "app-a", number: 12, packages: ["next"], kind: "merged", windowMin: 30 });
    expect(d.audit).toHaveBeenCalledWith(`${ACTIONS_COPY.auditPrefix}PR #12 merged · next`, APP);
  });

  it("still waiting for CI or the preview: only the stage is saved", async () => {
    const d = deps({ checks: vi.fn().mockResolvedValue(ok({ checkRuns: [{ status: "in_progress", conclusion: null }], combined: null })) });
    await watchDepPrs(now, deadline(), d);
    expect(d.saved).toEqual([{ set: { stage: "checks" }, text: "PR #12: waiting for CI" }]);
    expect(d.previews).not.toHaveBeenCalled();
    const p = deps({ previews: vi.fn().mockResolvedValue(ok([])) });
    await watchDepPrs(now, deadline(), p);
    expect(p.saved[0].text).toBe("PR #12: waiting for preview");
    expect(p.merge).not.toHaveBeenCalled();
  });

  it("fail: a failed check stops the PR, leaves it open and tells Telegram", async () => {
    const d = deps({ checks: vi.fn().mockResolvedValue(ok({ checkRuns: [{ status: "completed", conclusion: "failure" }], combined: null })) });
    expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 0, stopped: 1 });
    expect(d.saved[0]).toMatchObject({ set: { stage: "failed" }, text: "PR #12: needs a look ⚠️ — CI failed" });
    expect(d.notify).toHaveBeenCalledWith({ app: "app-a", number: 12, packages: ["next"], kind: "stopped", reason: "CI failed" });
    expect(d.merge).not.toHaveBeenCalled();
  });

  it("a failed check while the runner is still updating the lockfile waits instead of stopping", async () => {
    const lockfileBusy = vi.fn().mockResolvedValue(true);
    const d = deps({ lockfileBusy, checks: vi.fn().mockResolvedValue(ok({ checkRuns: [{ status: "completed", conclusion: "failure" }], combined: null })) });
    expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 0, stopped: 0 });
    expect(lockfileBusy).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^watchpost\/deps-/), expect.any(String));
    expect(d.saved[0]).toMatchObject({ set: { stage: "checks" }, text: expect.stringContaining("waiting for the lockfile from the runner") });
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("timeout after 45 minutes", async () => {
    const d = deps({ rows: vi.fn().mockResolvedValue([row({ openedAt: min(50) })]), previews: vi.fn().mockResolvedValue(ok([])) });
    await watchDepPrs(now, deadline(), d);
    expect(d.saved[0]).toMatchObject({ set: { stage: "timeout" }, text: "PR #12: needs a look ⚠️ — preview not ready within 45 minutes" });
    expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "stopped" }));
  });

  it("sha changed: a new commit restarts the checks; a 409 at merge time waits for the next round", async () => {
    const next = "b".repeat(40);
    const d = deps({ pull: vi.fn().mockResolvedValue(ok({ state: "open", merged: false, mergeable: true, headSha: next, branch: "x", base: "main" })) });
    await watchDepPrs(now, deadline(), d);
    expect(d.saved[0].set).toMatchObject({ stage: "checks", headSha: next, previewReadyAt: null, smokeMode: null });
    expect(d.merge).not.toHaveBeenCalled();
    const m = deps({ merge: vi.fn().mockResolvedValue({ ok: false, kind: "format", status: 409, error: "moved" }) });
    await watchDepPrs(now, deadline(), m);
    expect(m.saved.at(-1)).toMatchObject({ set: { stage: "checks" }, text: "PR #12: waiting for CI — new commit on the PR branch, checking again" });
    expect(m.notify).not.toHaveBeenCalled();
  });

  it("auto-rollback off: stops ready for a manual merge and says so", async () => {
    const d = deps({ rollback: vi.fn().mockResolvedValue({ enabled: false, windowMin: 30 }) });
    await watchDepPrs(now, deadline(), d);
    expect(d.merge).not.toHaveBeenCalled();
    expect(d.saved[0]).toMatchObject({ set: { stage: "ready-manual" }, text: "PR #12: ready to merge (manual)" });
    expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "ready-manual" }));
  });

  it("smoke modes: behind Vercel Authentication the preview's logs decide (3 quiet minutes after READY)", async () => {
    const d = deps({ probe: vi.fn().mockResolvedValue({ status: 401, ms: 40, authWall: true }), errorLogs: vi.fn().mockResolvedValue(0) });
    await watchDepPrs(now, deadline(), d);
    expect(d.errorLogs).toHaveBeenCalledWith({ token: "v", teamId: "team", projectId: "prj" }, "dpl_prev", min(5), now);
    expect(d.saved[0].set).toMatchObject({ stage: "merging", smokeMode: "logs" });
    const errs = deps({ probe: vi.fn().mockResolvedValue({ status: 401, ms: 40, authWall: true }), errorLogs: vi.fn().mockResolvedValue(3) });
    await watchDepPrs(now, deadline(), errs);
    expect(errs.saved[0]).toMatchObject({ set: { stage: "failed", smokeMode: "logs" }, text: "PR #12: needs a look ⚠️ — preview smoke test failed: 3 errors in the preview logs" });
    const http = deps({ probe: vi.fn().mockResolvedValue({ status: 500, ms: 40, authWall: false }) });
    await watchDepPrs(now, deadline(), http);
    expect(http.saved[0].text).toBe("PR #12: needs a look ⚠️ — preview smoke test failed: / answered 500");
  });

  it("an owner-approved PR is watched only while automatic security fixes are on; nothing without the write token", async () => {
    const d = deps({ rows: vi.fn().mockResolvedValue([row({ auto: false })]), security: vi.fn().mockResolvedValue({ enabled: false, severities: [], sameMajorOnly: true }) });
    expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 0, merged: 0, stopped: 0 });
    expect(d.pull).not.toHaveBeenCalled();
    const n = deps({ writeToken: vi.fn().mockResolvedValue(null) });
    await watchDepPrs(now, deadline(), n);
    expect(n.pull).not.toHaveBeenCalled();
  });

  it("checks unreadable with the write token fall back to the read token's Actions runs", async () => {
    const d = deps({
      checks: vi.fn().mockResolvedValue(ok({ checkRuns: null, combined: null })),
      runs: vi.fn().mockResolvedValue(ok([{ status: "completed", conclusion: "failure" }])),
    });
    await watchDepPrs(now, deadline(), d);
    expect(d.runs).toHaveBeenCalledWith("r", "o/acme-shop", SHA);
    expect(d.saved[0].text).toBe("PR #12: needs a look ⚠️ — CI failed");
  });
});

describe("runnerLockfileActive (the VM runner behind the registry)", () => {
  beforeEach(() => { delete ext.extensions.runner; });

  it("is false without a runner extension (the open source edition), without touching the database", async () => {
    expect(await runnerLockfileActive("r", "watchpost/deps-0a1b2c3d")).toBe(false);
  });

  it("asks the registered runner for that repository and branch; a runner error reads as false", async () => {
    const lockfileJobActive = vi.fn().mockResolvedValue(true);
    ext.extensions.runner = { queueLockfileJob: vi.fn(), lockfileJobActive };
    expect(await runnerLockfileActive("r", "watchpost/deps-0a1b2c3d")).toBe(true);
    expect(lockfileJobActive).toHaveBeenCalledWith("r", "watchpost/deps-0a1b2c3d");
    lockfileJobActive.mockRejectedValue(new Error("db down"));
    expect(await runnerLockfileActive("r", "watchpost/deps-0a1b2c3d")).toBe(false);
  });
});
