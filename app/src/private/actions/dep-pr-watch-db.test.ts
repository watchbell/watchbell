import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIONS_COPY } from "@/lib/copy/edition";

vi.mock("@/db/client", () => ({ db: () => { throw new Error("no database in tests"); } }));
// The registry the watcher reads the VM runner from (private edition: r1; open source edition: none).
const ext = vi.hoisted(() => ({ extensions: { nav: [], palette: [] } as { nav: never[]; palette: never[]; runner?: { queueLockfileJob: unknown; lockfileJobActive: (r: string, b: string) => Promise<boolean> } } }));
vi.mock("@/lib/extensions", () => ext);

import { depPrMinuteStep, liveProductionSource, mergeBlock, resetDepWatch, runnerLockfileActive, type WatchDeps, watchDepPrs } from "./dep-pr-watch-db";

// Watchbell 1.2 (review A1, minor 5): the merge watcher pauses with the DevOps section.
describe("depPrMinuteStep and the DevOps section", () => {
  it("does nothing while DevOps is off, and watches again once it is on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetDepWatch();
    await depPrMinuteStep(new Date("2026-10-16T10:00:00Z"), {}, async () => new Set(["devops"]));
    expect(warn).not.toHaveBeenCalled(); // no database read at all (the test database throws)
    resetDepWatch();
    await depPrMinuteStep(new Date("2026-10-16T10:00:00Z"), {}, async () => new Set());
    expect(warn).toHaveBeenCalledWith("deps/watch failed:", "Error");
    warn.mockRestore();
  });
});

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
const REVIEW = {
  manifest: "package.json", lockfile: "package-lock.json", tokenLogin: "owner",
  files: [{ filename: "package.json" }, { filename: "package-lock.json" }],
  commits: [{ sha: SHA, login: "owner", name: "Owner", email: "o@x", message: "Watchbell: update next", files: null }],
};

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
    review: vi.fn().mockResolvedValue(REVIEW),
    save: vi.fn(async (_id, set, _p, text) => { saved.push({ set: set as Record<string, unknown>, text }); }),
    notify: vi.fn().mockResolvedValue(undefined),
    audit: vi.fn().mockResolvedValue(undefined),
    book: vi.fn().mockResolvedValue({ db: [], app: [{ id: APP, name: "acme-shop", alias: "app-a" }] }),
    // D15 fix round 2: the live read before a merge (production built from main unless a test says otherwise).
    liveSource: vi.fn().mockResolvedValue({ source: { kind: "git", ref: "main", sha: SHA } }),
    ...o,
  };
}
const deadline = () => Date.now() + 50_000;

beforeEach(() => vi.clearAllMocks());

describe("watchDepPrs", () => {
  // Watchbell 1.2.1 (audit M1): the allow-list runs right before the merge.
  it("never merges a PR with a change outside package.json and its lockfile: stops with needs a look, stays open", async () => {
    const d = deps({ review: vi.fn().mockResolvedValue({ ...REVIEW, files: [...REVIEW.files, { filename: "src/app/page.tsx" }] }) });
    expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 0, stopped: 1 });
    expect(d.merge).not.toHaveBeenCalled();
    expect(d.review).toHaveBeenCalledWith("w", expect.objectContaining({ number: 12 }));
    expect(d.saved.at(-1)).toMatchObject({ set: { stage: "failed" }, text: "PR #12: needs a look ⚠️ — unexpected change in src/app/page.tsx" });
    expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "stopped", reason: "unexpected change in src/app/page.tsx" }));
  });

  // Owner (review round 1): when the scan recorded a lockfile, the merge waits for it.
  it("waits for the recorded lockfile instead of merging package.json alone", async () => {
    const d = deps({ review: vi.fn().mockResolvedValue({ ...REVIEW, lockfileRequired: true, files: [{ filename: "package.json" }] }) });
    expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 0, stopped: 0 });
    expect(d.merge).not.toHaveBeenCalled();
    expect(d.saved.at(-1)).toMatchObject({ set: { stage: "checks" }, text: "PR #12: waiting for CI — waiting for the lockfile" });
    const ok2 = deps({ review: vi.fn().mockResolvedValue({ ...REVIEW, lockfileRequired: true }) });
    expect((await watchDepPrs(now, deadline(), ok2)).merged).toBe(1);
  });

  it("never merges a PR with someone else's commit, and waits when GitHub can't be read", async () => {
    const d = deps({ review: vi.fn().mockResolvedValue({ ...REVIEW, commits: [...REVIEW.commits, { ...REVIEW.commits[0], sha: "c".repeat(40), login: "mallory" }] }) });
    expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 0, stopped: 1 });
    expect(d.saved.at(-1)?.text).toBe("PR #12: needs a look ⚠️ — unexpected commit ccccccc by mallory");
    const w = deps({ review: vi.fn().mockResolvedValue(null) });
    expect(await watchDepPrs(now, deadline(), w)).toEqual({ watched: 1, merged: 0, stopped: 0 });
    expect(w.merge).not.toHaveBeenCalled();
    expect(w.saved).toEqual([]);
  });

  // Watchbell 1.2.2 (D15, incident 25 Oct): production was built from another branch or deployed from the CLI; merging
  // into the PR's base would deploy that base to production and replace what is live. The PR stays open for the owner.
  // Fix round 1: the stage says "needs a look", never "ready to merge"; a reading older than 30 minutes can't confirm.
  it("refuses the merge when production wasn't built from the PR's base, or that can't be confirmed; merges when it was", async () => {
    const fresh = min(5).toISOString();
    for (const [productionSource, why] of [
      [{ kind: "cli", at: fresh }, "Production was deployed from the CLI, not built from main. Merging this PR would deploy main to production and replace what is live."],
      [{ kind: "git", ref: "web-revamp", at: fresh }, "Production was built from web-revamp, not main. Merging this PR would deploy main to production and replace what is live."],
      [{ kind: "git", ref: "main", at: min(31).toISOString() }, "Watchbell can't confirm what production is built from (no reading in the last 30 minutes). Merging this PR could deploy main to production and replace what is live."],
    ] as const) {
      const d = deps({ rows: vi.fn().mockResolvedValue([row({ meta: { productionBranch: "main", productionSource } })]) });
      expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 0, stopped: 1 });
      expect(d.merge).not.toHaveBeenCalled();
      expect(d.saved.at(-1)).toMatchObject({ set: { stage: "failed" }, text: expect.stringContaining(`PR #12: needs a look ⚠️ — ${why.slice(0, 60)}`) });
      expect(d.saved.at(-1)?.text).not.toContain("ready to merge");
      expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "stopped", reason: why.replace(/\.$/, "") }));
    }
    const same = deps({ rows: vi.fn().mockResolvedValue([row({ meta: { productionSource: { kind: "git", ref: "main", sha: SHA, at: fresh } } })]) });
    expect(await watchDepPrs(now, deadline(), same)).toEqual({ watched: 1, merged: 1, stopped: 0 });
  });

  // Fix round 1b: the PR's base is the branch production was promoted from, not the Vercel production branch; merging
  // there deploys nothing to production by itself, so the owner merges and promotes.
  it("never merges into a base that isn't the production branch when production was promoted from it", async () => {
    const at = min(5).toISOString();
    const d = deps({ rows: vi.fn().mockResolvedValue([row({ baseBranch: "web-revamp", meta: { productionBranch: "main", productionSource: { kind: "git", ref: "web-revamp", at } } })]),
      pull: vi.fn().mockResolvedValue(ok({ state: "open", merged: false, mergeable: true, headSha: SHA, branch: "watchpost/deps-0a1b2c3d", base: "web-revamp" })) });
    expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 0, stopped: 1 });
    expect(d.merge).not.toHaveBeenCalled();
    const why = "Merging into web-revamp won't deploy to production by itself: production was promoted from a web-revamp preview. Merge, then promote the new preview.";
    expect(d.saved.at(-1)).toMatchObject({ set: { stage: "failed" }, text: `PR #12: needs a look ⚠️ — ${why}` });
    expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "stopped", reason: why.replace(/\.$/, "") }));
    // The production branch itself (1.2.1's case) still merges.
    const prod = deps({ rows: vi.fn().mockResolvedValue([row({ baseBranch: "web-revamp", meta: { productionBranch: "web-revamp", productionSource: { kind: "git", ref: "web-revamp", at } } })]),
      pull: vi.fn().mockResolvedValue(ok({ state: "open", merged: false, mergeable: true, headSha: SHA, branch: "watchpost/deps-0a1b2c3d", base: "web-revamp" })),
      liveSource: vi.fn().mockResolvedValue({ source: { kind: "git", ref: "web-revamp" } }) });
    expect((await watchDepPrs(now, deadline(), prod)).merged).toBe(1);
  });

  // Fix round 2 (re-review I1): with auto-rollback off the PR would stop at "ready to merge (manual)"; a mismatch, an old
  // reading or the 1b case says "needs a look" with the reason instead, and Telegram gets the "stopped" notice.
  it("auto-rollback off: a blocked PR is 'needs a look' with the reason, never 'ready to merge (manual)'", async () => {
    const at = min(5).toISOString();
    for (const [r, live, why] of [
      [row({ meta: { productionBranch: "main", productionSource: { kind: "cli", at } } }), "main", "Production was deployed from the CLI, not built from main."],
      [row({ meta: { productionBranch: "main", productionSource: { kind: "git", ref: "main", at: min(31).toISOString() } } }), "main", "Watchbell can't confirm what production is built from"],
      [row({ baseBranch: "web-revamp", meta: { productionBranch: "main", productionSource: { kind: "git", ref: "web-revamp", at } } }), "web-revamp", "Merging into web-revamp won't deploy to production by itself"],
    ] as const) {
      const d = deps({
        rows: vi.fn().mockResolvedValue([r]), rollback: vi.fn().mockResolvedValue({ enabled: false, windowMin: 30 }),
        pull: vi.fn().mockResolvedValue(ok({ state: "open", merged: false, mergeable: true, headSha: SHA, branch: "watchpost/deps-0a1b2c3d", base: r.baseBranch })),
        liveSource: vi.fn().mockResolvedValue({ source: { kind: "git", ref: live } }),
      });
      expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 0, stopped: 1 });
      expect(d.merge).not.toHaveBeenCalled();
      expect(d.saved.at(-1)).toMatchObject({ set: { stage: "failed" }, text: expect.stringContaining(`PR #12: needs a look ⚠️ — ${why}`) });
      expect(d.saved.at(-1)?.text).not.toContain("ready to merge");
      expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "stopped", reason: expect.stringContaining(why.replace(/\.$/, "")) }));
      expect(d.notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "ready-manual" }));
    }
    // Nothing against it: still "ready to merge (manual)" as before.
    const clean = deps({ rows: vi.fn().mockResolvedValue([row({ meta: { productionSource: { kind: "git", ref: "main", at } } })]), rollback: vi.fn().mockResolvedValue({ enabled: false, windowMin: 30 }) });
    await watchDepPrs(now, deadline(), clean);
    expect(clean.saved.at(-1)).toMatchObject({ set: { stage: "ready-manual" } });
  });

  // Fix round 2 (re-review residual risk): one live read of what production is built from, right before the merge.
  describe("the live read before a merge", () => {
    it("a source never recorded, but Vercel says production was deployed from the CLI now: needs a look, no merge", async () => {
      const d = deps({ liveSource: vi.fn().mockResolvedValue({ source: { kind: "cli" } }) });
      expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 0, stopped: 1 });
      expect(d.liveSource).toHaveBeenCalledWith(APP);
      expect(d.merge).not.toHaveBeenCalled();
      expect(d.saved.at(-1)).toMatchObject({ set: { stage: "failed" }, text: expect.stringContaining("needs a look ⚠️ — Production was deployed from the CLI, not built from main.") });
    });
    it("a stored reading that still says main, but a CLI deploy since: no merge", async () => {
      const d = deps({
        rows: vi.fn().mockResolvedValue([row({ meta: { productionBranch: "main", productionSource: { kind: "git", ref: "main", at: min(2).toISOString() } } })]),
        liveSource: vi.fn().mockResolvedValue({ source: { kind: "cli", ref: "web-revamp" } }),
      });
      expect(await watchDepPrs(now, deadline(), d)).toMatchObject({ merged: 0, stopped: 1 });
      expect(d.merge).not.toHaveBeenCalled();
    });
    // Fix round 3 (re-review r2 minor 1): the wait is said on the PR, and it ends.
    it("Vercel can't be read: no merge, the stage says so, the next round tries again", async () => {
      const d = deps({ liveSource: vi.fn().mockResolvedValue(null) });
      expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 0, stopped: 0 });
      expect(d.merge).not.toHaveBeenCalled();
      expect(d.saved).toEqual([{ set: expect.objectContaining({ stage: "checks" }), text: "PR #12: waiting for CI — waiting: Vercel didn't say which deployment is live" }]);
      expect(d.notify).not.toHaveBeenCalled();
      const thrown = deps({ liveSource: vi.fn().mockRejectedValue(new Error("network")), rows: vi.fn().mockResolvedValue([row({ stage: "smoke" })]) });
      expect(await watchDepPrs(now, deadline(), thrown)).toEqual({ watched: 1, merged: 0, stopped: 0 });
      expect(thrown.merge).not.toHaveBeenCalled();
      expect(thrown.saved.at(-1)?.text).toBe("PR #12: smoke test — waiting: Vercel didn't say which deployment is live");
    });
    const WAITED = "PR #12: smoke test — waiting: Vercel didn't say which deployment is live";
    it("Vercel still can't say which deployment is live 45 minutes after the preview was ready, after a round that waited: needs a look", async () => {
      const d = deps({ liveSource: vi.fn().mockResolvedValue(null), rows: vi.fn().mockResolvedValue([row({ stage: "smoke", previewReadyAt: min(46), openedAt: min(60), stageText: WAITED })]) });
      expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 0, stopped: 1 });
      expect(d.merge).not.toHaveBeenCalled();
      expect(d.saved.at(-1)).toMatchObject({ set: { stage: "failed" }, text: expect.stringContaining("needs a look ⚠️ — Vercel didn't say which deployment is live for 45 minutes") });
      expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "stopped" }));
    });
    // Re-review r3 minor 4: the clock's base is the preview's ready time (not openedAt), with the boundary.
    it("counts from the preview's ready time: 44 minutes waits even when the PR opened over 45 minutes ago", async () => {
      const d = deps({ liveSource: vi.fn().mockResolvedValue(null), rows: vi.fn().mockResolvedValue([row({ stage: "smoke", previewReadyAt: min(44), openedAt: min(90), stageText: WAITED })]) });
      expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 0, stopped: 0 });
      expect(d.saved.at(-1)?.text).toBe(WAITED);
    });
    // Re-review r3 minor 3: never on the first failed read (one transient failure), even long after the preview.
    it("the first failed read never stops the PR, however late; the next failed one does", async () => {
      const r = row({ stage: "smoke", previewReadyAt: min(120), openedAt: min(130), stageText: "PR #12: smoke test" });
      const d = deps({ liveSource: vi.fn().mockResolvedValue(null), rows: vi.fn().mockResolvedValue([r]) });
      expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 0, stopped: 0 });
      expect(d.saved.at(-1)?.text).toBe(WAITED);
      const again = deps({ liveSource: vi.fn().mockResolvedValue(null), rows: vi.fn().mockResolvedValue([{ ...r, stageText: WAITED }]) });
      expect(await watchDepPrs(now, deadline(), again)).toEqual({ watched: 1, merged: 0, stopped: 1 });
    });
    // Re-review r2 minor 2: the same live read before a "ready to merge (manual)" stop (auto-rollback off).
    it("auto-rollback off: a source never recorded but a CLI deploy now is 'needs a look', not 'ready to merge'; a failed read waits", async () => {
      const off = { rollback: vi.fn().mockResolvedValue({ enabled: false, windowMin: 30 }) };
      const cli = deps({ ...off, liveSource: vi.fn().mockResolvedValue({ source: { kind: "cli" } }) });
      expect(await watchDepPrs(now, deadline(), cli)).toEqual({ watched: 1, merged: 0, stopped: 1 });
      expect(cli.saved.at(-1)).toMatchObject({ set: { stage: "failed" }, text: expect.stringContaining("Production was deployed from the CLI, not built from main.") });
      expect(cli.notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "ready-manual" }));
      const down = deps({ ...off, liveSource: vi.fn().mockResolvedValue(null) });
      expect(await watchDepPrs(now, deadline(), down)).toEqual({ watched: 1, merged: 0, stopped: 0 });
      expect(down.saved.at(-1)?.text).toContain("waiting: Vercel didn't say which deployment is live");
      expect(down.notify).not.toHaveBeenCalled();
      const fine = deps(off);
      await watchDepPrs(now, deadline(), fine);
      expect(fine.saved.at(-1)).toMatchObject({ set: { stage: "ready-manual" } });
      expect(fine.liveSource).toHaveBeenCalledWith(APP);
    });
    // Re-review r2 I1: a redeploy or promote of a CLI deployment (only the CLI's gitCommitRef names the branch).
    it("a redeploy of a CLI deployment read live is a CLI deploy: no merge", async () => {
      const vercel = vi.fn().mockResolvedValue({ token: "v", teamId: "team", projectId: "prj" });
      const serving = vi.fn().mockResolvedValue(ok({ currentId: "dpl_live", latest: null, promote: null }));
      const deployment = vi.fn().mockResolvedValue(ok({ id: "dpl_live", source: "redeploy", branch: "main", sha: null, branchFrom: "cli" }));
      expect(await liveProductionSource(APP, { vercel, serving, deployment })).toEqual({ source: { kind: "cli", ref: "main" } });
      const d = deps({
        rows: vi.fn().mockResolvedValue([row({ meta: { productionBranch: "main", productionSource: { kind: "git", ref: "main", at: min(2).toISOString() } } })]),
        liveSource: (appId) => liveProductionSource(appId, { vercel, serving, deployment }),
      });
      expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 0, stopped: 1 });
      expect(d.merge).not.toHaveBeenCalled();
      expect(d.saved.at(-1)?.text).toContain("Production was deployed from the CLI, not built from main.");
    });
    // Re-review r2 minor 5: the live 1b path (the stored reading is old news; the live one says production was promoted).
    it("live: production promoted from the PR's base, which isn't the production branch: no merge", async () => {
      const d = deps({
        rows: vi.fn().mockResolvedValue([row({ baseBranch: "web-revamp", meta: { productionBranch: "main" } })]),
        pull: vi.fn().mockResolvedValue(ok({ state: "open", merged: false, mergeable: true, headSha: SHA, branch: "watchpost/deps-0a1b2c3d", base: "web-revamp" })),
        liveSource: vi.fn().mockResolvedValue({ source: { kind: "git", ref: "web-revamp" } }),
      });
      expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 0, stopped: 1 });
      expect(d.saved.at(-1)?.text).toContain("Merging into web-revamp won't deploy to production by itself");
    });
    it("a live deployment that names no source can't be confirmed: needs a look", async () => {
      const d = deps({ liveSource: vi.fn().mockResolvedValue({ source: null }) });
      expect(await watchDepPrs(now, deadline(), d)).toMatchObject({ merged: 0, stopped: 1 });
      expect(d.saved.at(-1)?.text).toContain("can't confirm what production is built from");
    });
    it("liveProductionSource reads the served deployment and its source", async () => {
      const vercel = vi.fn().mockResolvedValue({ token: "v", teamId: "team", projectId: "prj" });
      const serving = vi.fn().mockResolvedValue(ok({ currentId: "dpl_live", latest: { id: "dpl_live", readyState: "READY", createdAt: 1 }, promote: null }));
      const deployment = vi.fn().mockResolvedValue(ok({ id: "dpl_live", source: "cli", branch: "web-revamp", sha: null }));
      expect(await liveProductionSource(APP, { vercel, serving, deployment })).toEqual({ source: { kind: "cli", ref: "web-revamp" } });
      expect(serving).toHaveBeenCalledWith("v", "team", "prj");
      expect(deployment).toHaveBeenCalledWith("v", expect.objectContaining({ id: "team" }), "dpl_live");
      expect(await liveProductionSource(APP, { vercel, serving: vi.fn().mockResolvedValue(ok({ currentId: null, latest: null, promote: null })), deployment })).toBeNull();
      expect(await liveProductionSource(APP, { vercel, serving: vi.fn().mockResolvedValue({ ok: false, kind: "transient", error: "x" }), deployment })).toBeNull();
      expect(await liveProductionSource(APP, { vercel: vi.fn().mockResolvedValue(null), serving, deployment })).toBeNull();
      // Re-review r2 minor 5: a failed read of the deployment itself.
      expect(await liveProductionSource(APP, { vercel, serving, deployment: vi.fn().mockResolvedValue({ ok: false, kind: "transient", error: "x" }) })).toBeNull();
    });

    // Fix round 4 (re-review r3 I1): the fallback only after a failed or canceled latest build, never while one runs.
    describe("when Vercel names no served deployment", () => {
      const vercel = vi.fn().mockResolvedValue({ token: "v", teamId: "team", projectId: "prj" });
      const servingWith = (readyState: string, promote: { toDeploymentId: string; requestedAt: number } | null = null) =>
        vi.fn().mockResolvedValue(ok({ currentId: null, latest: { id: "dpl_latest", readyState, createdAt: min(1).getTime() }, promote }));
      const readyList = () => vi.fn().mockResolvedValue(ok([
        { id: "dpl_old", source: "git", branch: "main", sha: null, branchFrom: "github", createdAt: min(90) },
        { id: "dpl_new", source: "cli", branch: null, sha: null, createdAt: min(30) },
      ]));
      const idle = () => vi.fn().mockResolvedValue(ok(null));

      it("a production build queued, initializing or building (a CLI deploy in progress): null, the PR waits", async () => {
        for (const state of ["QUEUED", "INITIALIZING", "BUILDING"]) {
          const ready = readyList();
          expect(await liveProductionSource(APP, { vercel, serving: servingWith(state), ready, running: idle(), deployment: vi.fn() })).toBeNull();
          expect(ready).not.toHaveBeenCalled();
        }
        // The latest failed but another production build is running: wait for it too.
        const running = vi.fn().mockResolvedValue(ok({ id: "dpl_run", state: "building" }));
        expect(await liveProductionSource(APP, { vercel, serving: servingWith("ERROR"), ready: readyList(), running, deployment: vi.fn() })).toBeNull();
        expect(running).toHaveBeenCalledWith("v", "team", "prj");
        // Through the watcher: no merge, the waiting text.
        const d = deps({
          rows: vi.fn().mockResolvedValue([row({ meta: { productionBranch: "main", productionSource: { kind: "git", ref: "main", at: min(2).toISOString() } } })]),
          liveSource: (appId) => liveProductionSource(appId, { vercel, serving: servingWith("BUILDING"), ready: readyList(), running: idle(), deployment: vi.fn() }),
        });
        expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 0, stopped: 0 });
        expect(d.merge).not.toHaveBeenCalled();
        expect(d.saved.at(-1)?.text).toContain("waiting: Vercel didn't say which deployment is live");
      });

      it("the latest failed or was canceled, none running: the newest READY production deployment", async () => {
        for (const state of ["ERROR", "CANCELED"]) {
          const ready = readyList();
          const deployment = vi.fn();
          expect(await liveProductionSource(APP, { vercel, serving: servingWith(state), ready, running: idle(), deployment })).toEqual({ source: { kind: "cli" } });
          expect(ready).toHaveBeenCalledWith("v", "team", "prj");
          expect(deployment).not.toHaveBeenCalled();
        }
        expect(await liveProductionSource(APP, { vercel, serving: servingWith("ERROR"), ready: vi.fn().mockResolvedValue(ok([])), running: idle(), deployment: vi.fn() })).toBeNull();
        expect(await liveProductionSource(APP, { vercel, serving: servingWith("ERROR"), ready: vi.fn().mockResolvedValue({ ok: false, kind: "transient", error: "x" }), running: idle(), deployment: vi.fn() })).toBeNull();
        expect(await liveProductionSource(APP, { vercel, serving: servingWith("ERROR"), ready: readyList(), running: vi.fn().mockResolvedValue({ ok: false, kind: "transient", error: "x" }), deployment: vi.fn() })).toBeNull();
      });

      // Re-review r3 minor 1: after a promote of an older deployment, the newest READY one before it isn't served.
      it("after a succeeded promote: a READY deployment created after it, else the promote's target", async () => {
        const deployment = vi.fn().mockResolvedValue(ok({ id: "dpl_promoted", source: "cli", branch: "web-revamp", sha: null }));
        // The promote (60 min ago) of an older CLI deployment; both READY ones in the list predate it except none: target.
        const before = vi.fn().mockResolvedValue(ok([{ id: "dpl_main", source: "git", branch: "main", sha: null, branchFrom: "github", createdAt: min(90) }]));
        expect(await liveProductionSource(APP, { vercel, serving: servingWith("ERROR", { toDeploymentId: "dpl_promoted", requestedAt: min(60).getTime() }), ready: before, running: idle(), deployment }))
          .toEqual({ source: { kind: "cli", ref: "web-revamp" } });
        expect(deployment).toHaveBeenCalledWith("v", expect.objectContaining({ id: "team" }), "dpl_promoted");
        // A READY deployment created after the promote is what's served.
        const after = vi.fn().mockResolvedValue(ok([
          { id: "dpl_main", source: "git", branch: "main", sha: null, branchFrom: "github", createdAt: min(20) },
          { id: "dpl_older", source: "cli", branch: null, sha: null, createdAt: min(90) },
        ]));
        expect(await liveProductionSource(APP, { vercel, serving: servingWith("ERROR", { toDeploymentId: "dpl_promoted", requestedAt: min(60).getTime() }), ready: after, running: idle(), deployment: vi.fn() }))
          .toEqual({ source: { kind: "git", ref: "main" } });
      });
    });
  });

  // Review minor 3: an app deleted (appId null) or no longer watched isn't read by the collector any more.
  it("never merges for an app that is gone or no longer watched", async () => {
    for (const o of [{ appMonitored: false }, { appGone: min(1) }]) {
      const d = deps({ rows: vi.fn().mockResolvedValue([row(o)]) });
      expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 0, stopped: 1 });
      expect(d.merge).not.toHaveBeenCalled();
      expect(d.saved.at(-1)?.text).toContain("no longer watched");
    }
    expect(mergeBlock({ appId: null, meta: null, baseBranch: "main" }, now)).toContain("gone or no longer watched");
    expect(mergeBlock({ appId: APP, appMonitored: true, appGone: null, meta: {}, baseBranch: "main" }, now)).toBeNull();
  });

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

  // Watchbell 1.2.1: the PR's recorded base (the app's production branch, deps-pr.ts prBase) is where it is merged; a
  // Moderate fix is watched and reported like any other (the watcher never looks at severities).
  it("merges into the recorded base branch (web-revamp), and a Moderate fix gets the same Telegram notice", async () => {
    const d = deps({
      rows: vi.fn().mockResolvedValue([row({ baseBranch: "web-revamp", packages: ["axios"], title: "Watchbell: update axios to 1.6.8 (security fix)" })]),
      security: vi.fn().mockResolvedValue({ enabled: true, severities: ["critical", "high", "moderate"], sameMajorOnly: true }),
      pull: vi.fn().mockResolvedValue(ok({ state: "open", merged: false, mergeable: true, headSha: SHA, branch: "watchpost/deps-0a1b2c3d", base: "web-revamp" })),
      liveSource: vi.fn().mockResolvedValue({ source: { kind: "git", ref: "web-revamp" } }),
    });
    expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 1, stopped: 0 });
    expect(d.merge).toHaveBeenCalledWith("w", "o/acme-shop", 12, "watchpost/deps-0a1b2c3d", "web-revamp", SHA, "Watchbell: update axios to 1.6.8 (security fix)");
    expect(d.notify).toHaveBeenCalledWith({ app: "app-a", number: 12, packages: ["axios"], kind: "merged", windowMin: 30 });
  });

  it("never merges a PR whose base was changed on GitHub: stops with needs a look and tells Telegram", async () => {
    const d = deps({
      rows: vi.fn().mockResolvedValue([row({ baseBranch: "web-revamp" })]),
      pull: vi.fn().mockResolvedValue(ok({ state: "open", merged: false, mergeable: true, headSha: SHA, branch: "watchpost/deps-0a1b2c3d", base: "main" })),
    });
    expect(await watchDepPrs(now, deadline(), d)).toEqual({ watched: 1, merged: 0, stopped: 1 });
    expect(d.merge).not.toHaveBeenCalled();
    expect(d.saved.at(-1)?.text).toBe("PR #12: needs a look ⚠️ — the PR's base changed to main");
    expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "stopped", reason: "the PR's base changed to main" }));
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
