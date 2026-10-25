import { describe, expect, it } from "vitest";
import {
  AFTER_DEPLOY_TTL_MS, CHECKED_MAX, deployToMark, expireMarks, hasPending, markDeploys, marksNeeding, MAX_ATTEMPTS, newCurrent, parseAfterDeploy, pendingApps, recordRun, settleMarks,
} from "./after-deploy";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-10-24T10:00:00Z");
const empty = () => parseAfterDeploy(null);

describe("parseAfterDeploy", () => {
  it("reads what is stored; anything odd is left out", () => {
    expect(parseAfterDeploy(null)).toEqual({ pending: {}, checked: {} });
    expect(parseAfterDeploy("x")).toEqual({ pending: {}, checked: {} });
    expect(parseAfterDeploy({
      pending: { [A]: { id: "dpl_1", at: now.toISOString(), attempts: 2, next: true, deps: "yes" }, "not-a-uuid": { id: "dpl_2", at: now.toISOString() }, [B]: { id: 3, at: "x" } },
      checked: { [B]: "dpl_0", [A]: 7 },
    })).toEqual({ pending: { [A]: { id: "dpl_1", at: now.toISOString(), attempts: 2, next: true } }, checked: { [B]: "dpl_0" } });
    // A mark stored before fix round 1 (no attempts) reads as 0 attempts.
    expect(parseAfterDeploy({ pending: { [A]: { id: "dpl_1", at: now.toISOString() } } }).pending[A]).toEqual({ id: "dpl_1", at: now.toISOString(), attempts: 0 });
  });
});

// Watchbell 1.2.1: taskVercel marks an app whose current production deployment changed; the next `security` run checks
// it first, and only once per deployment.
describe("marks after a production deploy", () => {
  it("a new current deployment marks its app; the same deployment again changes nothing", () => {
    const one = markDeploys(empty(), [{ appId: A, deploymentId: "dpl_new" }], now);
    expect(one.changed).toBe(true);
    expect(pendingApps(one.state)).toEqual([A]);
    expect(hasPending(one.state)).toBe(true);
    expect(markDeploys(one.state, [{ appId: A, deploymentId: "dpl_new" }], now).changed).toBe(false);
  });

  it("never checks the same deployment twice: once settled, marking it again does nothing", () => {
    const marked = markDeploys(empty(), [{ appId: A, deploymentId: "dpl_new" }, { appId: B, deploymentId: "dpl_b" }], now).state;
    const settled = settleMarks(marked, [A]);
    expect(settled).toEqual({ pending: { [B]: { id: "dpl_b", at: now.toISOString(), attempts: 0 } }, checked: { [A]: "dpl_new" } });
    expect(markDeploys(settled, [{ appId: A, deploymentId: "dpl_new" }], now).changed).toBe(false);
    // A later deployment of the same app is checked again (a rollback too: it is a new current deployment).
    expect(pendingApps(markDeploys(settled, [{ appId: A, deploymentId: "dpl_newer" }], now).state)).toEqual([B, A]);
  });

  it("a newer deployment before the check replaces the older mark (one check for the burst)", () => {
    const s = markDeploys(markDeploys(empty(), [{ appId: A, deploymentId: "dpl_1" }], now).state, [{ appId: A, deploymentId: "dpl_2" }], now).state;
    expect(s.pending).toEqual({ [A]: { id: "dpl_2", at: now.toISOString(), attempts: 0 } });
  });

  it("drops a mark older than the TTL (the 6-hourly run covers it), so a mark can't keep the minute run busy", () => {
    const s = markDeploys(empty(), [{ appId: A, deploymentId: "dpl_1" }], new Date(now.getTime() - AFTER_DEPLOY_TTL_MS - 1)).state;
    const fresh = markDeploys(s, [{ appId: B, deploymentId: "dpl_b" }], now).state;
    expect(expireMarks(fresh, now)).toEqual({ pending: { [B]: { id: "dpl_b", at: now.toISOString(), attempts: 0 } }, checked: { [A]: "dpl_1" } });
  });

  it("keeps at most CHECKED_MAX settled entries", () => {
    let s = empty();
    for (let i = 0; i < CHECKED_MAX + 5; i++) s.checked[`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`] = `dpl_${i}`;
    s = settleMarks(markDeploys(s, [{ appId: A, deploymentId: "dpl_a" }], now).state, [A]);
    expect(Object.keys(s.checked)).toHaveLength(CHECKED_MAX);
    expect(s.checked[A]).toBe("dpl_a");
  });
});

describe("newCurrent", () => {
  it("is the current deployment when the flag update changed its row (it wasn't current before)", () => {
    expect(newCurrent(["dpl_new", "dpl_old"], "dpl_new")).toBe("dpl_new");
    expect(newCurrent(["dpl_old"], "dpl_new")).toBeNull(); // only the previous flag moved
    expect(newCurrent([], "dpl_new")).toBeNull();
    expect(newCurrent(["dpl_x"], null)).toBeNull();
  });
});

// Fix round 1 (review important 2): per-part progress and at most MAX_ATTEMPTS tries of a check that runs out of time.
describe("recordRun", () => {
  const both = { hosting: true, devops: true };
  const marked = () => markDeploys(empty(), [{ appId: A, deploymentId: "dpl_new" }, { appId: B, deploymentId: "dpl_b" }], now).state;

  it("a finished part is remembered, so the next run does only the other part", () => {
    const s = recordRun(marked(), { ...both, nextDone: new Set([A]), nextStarted: new Set([A]), depsDone: new Set() });
    expect(s.pending[A]).toMatchObject({ next: true, attempts: 0 });
    expect(marksNeeding(s, "next")).toEqual([B]);
    expect(marksNeeding(s, "deps")).toEqual([A, B]);
    const done = recordRun(s, { ...both, depsDone: new Set([A]) });
    expect(done.pending[A]).toBeUndefined();
    expect(done.checked[A]).toBe("dpl_new");
  });

  it("a check that started and ran out of time is an attempt; after MAX_ATTEMPTS the mark is settled", () => {
    expect(MAX_ATTEMPTS).toBe(3);
    let s = marked();
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      s = recordRun(s, { ...both, nextStarted: new Set([A]), depsDone: new Set([A]) });
      expect(s.pending[A]).toMatchObject({ attempts: i, deps: true });
    }
    s = recordRun(s, { ...both, nextStarted: new Set([A]) });
    expect(s.pending[A]).toBeUndefined();
    expect(s.checked[A]).toBe("dpl_new");
    expect(s.pending[B]).toMatchObject({ attempts: 0 }); // not started: not an attempt
  });

  it("a paused part isn't waited for", () => {
    const s = recordRun(marked(), { hosting: false, devops: true, depsDone: new Set([A, B]) });
    expect(s.pending).toEqual({});
  });
});

// Fix round 1 (review minor 2): the Vercel task marks a newly current deployment, and also a recent current one that
// isn't marked or checked yet (a mark whose write failed is retried on the next run).
describe("deployToMark", () => {
  const recent = new Date(now.getTime() - 60_000);
  const old = new Date(now.getTime() - AFTER_DEPLOY_TTL_MS - 60_000);
  it("marks a deployment that just became current, even an old one (a rollback)", () => {
    expect(deployToMark({ appId: A, currentId: "dpl_old", changedIds: ["dpl_old"], createdAt: old, state: empty(), now })).toBe("dpl_old");
  });
  it("marks a recent current deployment that was never marked (a lost write), but not an old one", () => {
    expect(deployToMark({ appId: A, currentId: "dpl_new", changedIds: [], createdAt: recent, state: empty(), now })).toBe("dpl_new");
    expect(deployToMark({ appId: A, currentId: "dpl_new", changedIds: [], createdAt: old, state: empty(), now })).toBeNull();
    expect(deployToMark({ appId: A, currentId: "dpl_new", changedIds: [], createdAt: null, state: empty(), now })).toBeNull();
  });
  it("never marks a deployment that is already waiting or checked", () => {
    const pending = markDeploys(empty(), [{ appId: A, deploymentId: "dpl_new" }], now).state;
    expect(deployToMark({ appId: A, currentId: "dpl_new", changedIds: ["dpl_new"], createdAt: recent, state: pending, now })).toBeNull();
    expect(deployToMark({ appId: A, currentId: "dpl_new", changedIds: [], createdAt: recent, state: settleMarks(pending, [A]), now })).toBeNull();
    expect(deployToMark({ appId: A, currentId: null, changedIds: [], createdAt: recent, state: empty(), now })).toBeNull();
  });
});
