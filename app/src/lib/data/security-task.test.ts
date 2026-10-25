import { describe, expect, it, vi } from "vitest";

vi.mock("@/db/client", () => ({ db: () => { throw new Error("no database in tests"); } }));

import { slotStart } from "@/lib/collector/schedule";
import type { SectionId } from "@/lib/sections";
import { AFTER_DEPLOY_TTL_MS, MAX_ATTEMPTS } from "@/lib/security/after-deploy";
import { CUT_TRIES, SLOT_MAX_RUNS } from "@/lib/security/slot";
import type { SecurityRun } from "./security-db";
import { markAfterDeploy, marksPending, type SecurityTaskDeps, taskSecurity } from "./security-task";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-10-24T10:37:00Z");
const SLOT = new Date(slotStart("security", now)).toISOString();
const stored = (pending: Record<string, string>, at = now, extra: Record<string, unknown> = {}) => ({
  pending: Object.fromEntries(Object.entries(pending).map(([app, id]) => [app, { id, at: at.toISOString(), attempts: 0, ...extra }])), checked: {},
});
type Pick = { first?: readonly string[]; only?: readonly string[]; skip?: readonly string[] };
const nextRun = (o: Partial<SecurityRun>): SecurityRun => ({ checked: 0, skipped: 0, failed: [], done: [], listed: [], started: [], ...o });
// Every check it is asked for finishes.
const allDone = async (_d: number, pick: Pick) => {
  const ids = [...(pick.only ?? pick.first ?? [])];
  return nextRun({ checked: ids.length, done: ids, listed: ids, started: ids });
};

function deps(raw: unknown, o: Partial<SecurityTaskDeps> = {}, slotRaw: unknown = null) {
  const state = { raw, slot: slotRaw };
  const d: SecurityTaskDeps & { state: typeof state } = {
    state,
    read: vi.fn(async () => state.raw),
    write: vi.fn(async (v: unknown) => { state.raw = v; }),
    readSlot: vi.fn(async () => state.slot),
    writeSlot: vi.fn(async (v: unknown) => { state.slot = v; }),
    nextCheck: vi.fn(allDone),
    depsStep: vi.fn(async (_deadline: number, pick: { marked: readonly string[] }) => ({ problem: null, settled: [...pick.marked], done: [], complete: true })),
    ...o,
  };
  return d;
}
const run = (d: SecurityTaskDeps, o: { early?: boolean; paused?: SectionId[]; deadline?: number } = {}) => {
  const errors: string[] = [];
  return taskSecurity({ now, deadline: o.deadline ?? Date.now() + 15_000, errors, paused: new Set(o.paused ?? []), early: o.early ?? false }, d)
    .then((r) => ({ ...r, errors }));
};

describe("taskSecurity: the 6-hourly slot (Watchbell 1.2.1)", () => {
  it("checks every app and scans the repositories, the marked app first, then settles its mark and completes the slot", async () => {
    const d = deps(stored({ [A]: "dpl_new" }));
    expect(await run(d)).toEqual({ complete: true, errors: [] });
    expect(d.nextCheck).toHaveBeenCalledWith(expect.any(Number), { first: [A], skip: [] });
    expect(d.depsStep).toHaveBeenCalledWith(expect.any(Number), { marked: [A], onlyMarked: false, skip: [] });
    expect(d.state.raw).toEqual({ pending: {}, checked: { [A]: "dpl_new" } });
    expect(d.state.slot).toMatchObject({ slot: SLOT, runs: 1, nextDone: true, depsDone: true });
  });

  // Review important 1: one minute run can't do it all, so the slot continues in the next runs, never repeating an item.
  it("with many apps and repositories, continues over the next minute runs until both lists are done", async () => {
    const apps = Array.from({ length: 10 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    const repos = ["r1", "r2", "r3"];
    const nextCheck = vi.fn(async (_d: number, pick: Pick) => {
      const left = apps.filter((a) => !(pick.skip ?? []).includes(a));
      const started = left.slice(0, 4);
      return nextRun({ checked: started.length, done: started, started, listed: left, skipped: left.length - started.length });
    });
    const depsStep = vi.fn(async (_d: number, pick: { skip?: readonly string[] }) => {
      const left = repos.filter((r) => !(pick.skip ?? []).includes(r));
      return { problem: null, settled: [], done: left.slice(0, 2), complete: left.length <= 2 };
    });
    const d = deps(null, { nextCheck, depsStep });
    const deadline = Date.now() + 15_000;
    expect((await run(d, { deadline })).complete).toBe(false);
    // Fix round 2: in a slot run the dependency scan goes first (each repository is bounded by MIN_REPO_MS), then the
    // Next.js checks get the rest of the window, uncapped.
    expect(depsStep.mock.invocationCallOrder[0]).toBeLessThan(nextCheck.mock.invocationCallOrder[0]);
    expect(nextCheck.mock.calls[0][0]).toBe(deadline);
    expect(d.state.slot).toMatchObject({ runs: 1, next: apps.slice(0, 4), repos: ["r1", "r2"], nextDone: false, depsDone: false });
    expect((await run(d, { deadline })).complete).toBe(false);
    expect(nextCheck.mock.calls[1][1]).toEqual({ first: [], skip: apps.slice(0, 4) });
    expect(depsStep.mock.calls[1][1]).toEqual({ marked: [], onlyMarked: false, skip: ["r1", "r2"] });
    expect(d.state.slot).toMatchObject({ runs: 2, depsDone: true, nextDone: false });
    expect((await run(d, { deadline })).complete).toBe(true);
    expect(depsStep).toHaveBeenCalledTimes(2); // its list was done: not asked again in this slot
    expect(new Set((d.state.slot as { next: string[] }).next)).toEqual(new Set(apps));
  });

  it("a new slot starts over; a slot never takes more than SLOT_MAX_RUNS runs", async () => {
    const d = deps(null, {}, { slot: "2026-10-24T04:36:00.000Z", runs: 5, next: [A], repos: ["r1"], nextDone: true, depsDone: true });
    await run(d);
    expect(d.nextCheck).toHaveBeenCalledWith(expect.any(Number), { first: [], skip: [] });
    const stuck = deps(null, {
      nextCheck: vi.fn(async () => nextRun({ listed: [A], skipped: 1 })),
    }, { slot: SLOT, runs: SLOT_MAX_RUNS - 1, next: [], repos: [], nextDone: false, depsDone: true });
    expect((await run(stuck)).complete).toBe(true);
  });

  // Fix round 2 (re-review important 1): a check cut by the time limit isn't done; it is tried again in a later run of
  // the same slot, and after CUT_TRIES cuts the app is left to the daily job so the slot can complete.
  it("an app whose check was cut is checked again in a later run of the slot; the slot completes after at most 2 tries", async () => {
    let calls = 0;
    const nextCheck = vi.fn(async (_d: number, pick: Pick) => {
      calls++;
      const listed = [A, B].filter((a) => !(pick.skip ?? []).includes(a));
      // Run 1: A finishes, B starts and is cut. Run 2: B finishes.
      return calls === 1 ? nextRun({ listed, started: [A, B], done: [A], skipped: 1 }) : nextRun({ listed, started: listed, done: listed });
    });
    const d = deps(null, { nextCheck });
    expect((await run(d)).complete).toBe(false);
    expect(d.state.slot).toMatchObject({ next: [A], cut: { [B]: 1 }, nextDone: false });
    expect((await run(d)).complete).toBe(true);
    expect(nextCheck.mock.calls[1][1]).toEqual({ first: [], skip: [A] }); // B is asked again
    expect(d.state.slot).toMatchObject({ next: [A, B], nextDone: true });

    // Cut every time: two tries, then the slot completes without it.
    const always = vi.fn(async (_d: number, pick: Pick) => {
      const listed = [B].filter((a) => !(pick.skip ?? []).includes(a));
      return nextRun({ listed, started: listed, done: [], skipped: listed.length });
    });
    const slow = deps(null, { nextCheck: always });
    expect((await run(slow)).complete).toBe(false);
    expect((await run(slow)).complete).toBe(true);
    expect(always).toHaveBeenCalledTimes(CUT_TRIES);
    expect(slow.state.slot).toMatchObject({ cut: { [B]: CUT_TRIES }, nextDone: true });
  });

  // Fix round 2 (re-review minor 1): the slot and the marks are saved independently, so the run cap holds.
  it("saves the slot even when saving the marks fails, and the marks when saving the slot fails; the error still surfaces", async () => {
    const marksFail = deps(stored({ [A]: "dpl_new" }), { write: vi.fn(async () => { throw new Error("marks write"); }) });
    await expect(run(marksFail)).rejects.toThrow("marks write");
    expect(marksFail.state.slot).toMatchObject({ runs: 1 });
    const slotFail = deps(stored({ [A]: "dpl_new" }), { writeSlot: vi.fn(async () => { throw new Error("slot write"); }) });
    await expect(run(slotFail)).rejects.toThrow("slot write");
    expect(slotFail.state.raw).toEqual({ pending: {}, checked: { [A]: "dpl_new" } });
  });
});

describe("taskSecurity: after a production deploy (early runs)", () => {
  it("checks only the marked apps, once per deployment, and leaves the 6-hourly slot alone", async () => {
    const d = deps(stored({ [A]: "dpl_new" }));
    await run(d, { early: true });
    expect(d.nextCheck).toHaveBeenCalledWith(expect.any(Number), { only: [A] });
    expect(d.depsStep).toHaveBeenCalledWith(expect.any(Number), { marked: [A], onlyMarked: true });
    expect(d.readSlot).not.toHaveBeenCalled();
    expect(d.writeSlot).not.toHaveBeenCalled();
    vi.mocked(d.nextCheck).mockClear();
    vi.mocked(d.depsStep).mockClear();
    await run(d, { early: true });
    expect(d.nextCheck).not.toHaveBeenCalled();
    expect(d.depsStep).not.toHaveBeenCalled();
  });

  // Review important 2.
  it("a check that ran out of time is an attempt: at most MAX_ATTEMPTS tries, then the mark is settled", async () => {
    const nextCheck = vi.fn(async () => nextRun({ listed: [A], started: [A], skipped: 1 }));
    const d = deps(stored({ [A]: "dpl_new" }), { nextCheck });
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await run(d, { early: true });
    expect(nextCheck).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(d.state.raw).toEqual({ pending: {}, checked: { [A]: "dpl_new" } });
  });

  it("the Next.js check done but the dependency scan not: the next run does only the scan", async () => {
    const depsStep = vi.fn()
      .mockResolvedValueOnce({ problem: null, settled: [], done: [], complete: false })
      .mockResolvedValueOnce({ problem: null, settled: [A], done: ["r1"], complete: true });
    const d = deps(stored({ [A]: "dpl_new" }), { depsStep });
    await run(d, { early: true });
    expect(d.state.raw).toMatchObject({ pending: { [A]: { next: true } } });
    vi.mocked(d.nextCheck).mockClear();
    await run(d, { early: true });
    expect(d.nextCheck).not.toHaveBeenCalled();
    expect(depsStep).toHaveBeenCalledTimes(2);
    expect(d.state.raw).toEqual({ pending: {}, checked: { [A]: "dpl_new" } });
  });

  it("the dependency scan gets the whole time when only it is left", async () => {
    const d = deps(stored({ [A]: "dpl_new" }, now, { next: true }));
    const deadline = Date.now() + 15_000;
    await run(d, { early: true, deadline });
    expect(d.nextCheck).not.toHaveBeenCalled();
    expect(vi.mocked(d.depsStep).mock.calls[0][0]).toBeGreaterThan(deadline - 8_000);
  });

  it("a mark for an app that is no longer watched (not listed) is done, not retried every minute", async () => {
    const d = deps(stored({ [A]: "dpl_new" }), { nextCheck: vi.fn(async () => nextRun({})) });
    await run(d, { early: true });
    expect(d.state.raw).toEqual({ pending: {}, checked: { [A]: "dpl_new" } });
  });

  it("drops a mark older than the TTL without checking it", async () => {
    const d = deps(stored({ [A]: "dpl_old" }, new Date(now.getTime() - AFTER_DEPLOY_TTL_MS - 60_000)));
    await run(d, { early: true });
    expect(d.nextCheck).not.toHaveBeenCalled();
    expect(d.state.raw).toEqual({ pending: {}, checked: { [A]: "dpl_old" } });
  });

  // Review minor 4.
  it("saves the TTL and what finished even when a part throws", async () => {
    const d = deps({ ...stored({ [B]: "dpl_b" }), pending: { ...stored({ [B]: "dpl_b" }).pending, ...stored({ [A]: "dpl_old" }, new Date(now.getTime() - AFTER_DEPLOY_TTL_MS - 60_000)).pending } }, {
      depsStep: vi.fn(async () => { throw new Error("database gone"); }),
    });
    await expect(run(d, { early: true })).rejects.toThrow("database gone");
    expect(d.state.raw).toEqual({ pending: { [B]: { id: "dpl_b", at: now.toISOString(), attempts: 0, next: true } }, checked: { [A]: "dpl_old" } });
  });
});

describe("taskSecurity: sections and reporting", () => {
  it("DevOps off: no GitHub scan; Hosting off: no Next.js check (each part pauses with its section)", async () => {
    const devopsOff = deps(stored({ [A]: "dpl_new" }));
    expect((await run(devopsOff, { paused: ["devops"] })).complete).toBe(true);
    expect(devopsOff.depsStep).not.toHaveBeenCalled();
    expect(devopsOff.nextCheck).toHaveBeenCalled();
    expect(devopsOff.state.raw).toEqual({ pending: {}, checked: { [A]: "dpl_new" } });
    const hostingOff = deps(stored({ [A]: "dpl_new" }));
    expect((await run(hostingOff, { paused: ["hosting"] })).complete).toBe(true);
    expect(hostingOff.nextCheck).not.toHaveBeenCalled();
    expect(hostingOff.depsStep).toHaveBeenCalled();
  });

  it("reports failures as the daily step does, and writes no marks when none changed", async () => {
    const d = deps(null, {
      nextCheck: vi.fn(async () => nextRun({ failed: ["web: boom"] })),
      depsStep: vi.fn(async () => ({ problem: "acme/web: GitHub rejected the token (401)", settled: [], done: [], complete: true })),
    });
    expect((await run(d)).errors).toEqual(["security deps: acme/web: GitHub rejected the token (401)", "security web: boom"]); // a slot run scans first
    expect(d.write).not.toHaveBeenCalled();
  });
});

describe("markAfterDeploy (the Vercel task saw a new current production deployment)", () => {
  it("marks the app, so the next run checks it; the same deployment is never marked twice", async () => {
    const d = deps(null);
    expect(await markAfterDeploy([{ appId: A, deploymentId: "dpl_new" }], now, d)).toBe(true);
    expect(marksPending(d.state.raw)).toBe(true);
    expect(d.state.raw).toEqual(stored({ [A]: "dpl_new" }));
    expect(await markAfterDeploy([{ appId: A, deploymentId: "dpl_new" }], now, d)).toBe(false);
    await run(d, { early: true });
    expect(marksPending(d.state.raw)).toBe(false);
    expect(await markAfterDeploy([{ appId: A, deploymentId: "dpl_new" }], now, d)).toBe(false);
  });

  it("reads nothing when there is nothing to mark", async () => {
    const d = deps(null);
    expect(await markAfterDeploy([], now, d)).toBe(false);
    expect(d.read).not.toHaveBeenCalled();
  });
});
