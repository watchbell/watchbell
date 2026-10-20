import { describe, expect, it } from "vitest";
import { autoRollbackDecision, autoRollbackReason, deployRef, type RollbackCheck } from "./auto-rollback";

const now = new Date("2026-10-16T05:00:00Z");
const min = (m: number) => new Date(now.getTime() - m * 60_000);
const day = (d: number) => new Date(now.getTime() - d * 86_400_000);

const check = (o: Partial<RollbackCheck> = {}, d: Partial<NonNullable<RollbackCheck["deploy"]>> = {}): RollbackCheck => ({
  setting: { enabled: true, windowMin: 30 },
  ruleKey: "MonitorDown",
  targetRef: "dpl_prev0000001",
  deploy: {
    currentId: "dpl_new00000001", currentSha: "abcdef1234567", liveAt: min(12), currentCreatedAt: min(15), newestProdCreatedAt: min(15),
    previousId: "dpl_prev0000001", previousState: "ready", previousCreatedAt: day(3), ...d,
  },
  rolledOrPromotedLately: false, autoLately: false, sameDeployBefore: false, inFlight: false, ...o,
});
const why = (c: RollbackCheck) => { const r = autoRollbackDecision(c, now); return r.ok ? "ok" : r.why; };

describe("autoRollbackDecision", () => {
  it("runs a fresh, down deploy with a ready previous one", () => {
    expect(why(check())).toBe("ok");
    expect(why(check({ ruleKey: "LogErrorSpike" }))).toBe("ok");
  });
  it("only when switched on, and only from a down monitor or an error spike", () => {
    expect(why(check({ setting: { enabled: false, windowMin: 30 } }))).toBe("off");
    for (const ruleKey of ["HighLatency", "DeploymentFailed", null]) expect(why(check({ ruleKey }))).toBe("rule");
  });
  it("window math: inside N minutes of going live, inclusive; never in the future", () => {
    expect(why(check({}, { liveAt: min(30) }))).toBe("ok");
    expect(why(check({}, { liveAt: new Date(min(30).getTime() - 1) }))).toBe("outside the window");
    expect(why(check({ setting: { enabled: true, windowMin: 10 } }, { liveAt: min(11) }))).toBe("outside the window");
    expect(why(check({ setting: { enabled: true, windowMin: 120 } }, { liveAt: min(119) }))).toBe("ok");
    expect(why(check({}, { liveAt: new Date(now.getTime() + 60_000) }))).toBe("outside the window");
    expect(why(check({}, { liveAt: null }))).toBe("no live deploy");
    expect(why(check({ deploy: null }))).toBe("no live deploy");
  });
  it("refuses when the target is no longer the live deploy's previous", () => {
    expect(why(check({ targetRef: "dpl_other000001" }))).toBe("target changed");
    expect(why(check({}, { previousId: null }))).toBe("target changed");
  });
  it("never rolls back a rollback or a promote", () => {
    expect(why(check({}, { currentCreatedAt: day(2), newestProdCreatedAt: min(15) }))).toBe("live deploy is a rollback");
    expect(why(check({ rolledOrPromotedLately: true }))).toBe("live deploy came from a rollback or promote");
  });
  it("never to a previous deployment that isn't READY or is older than 30 days", () => {
    expect(why(check({}, { previousState: "error" }))).toBe("previous not ready");
    expect(why(check({}, { previousState: null }))).toBe("previous not ready");
    expect(why(check({}, { previousState: "READY" }))).toBe("ok");
    expect(why(check({}, { previousCreatedAt: day(31) }))).toBe("previous too old");
    expect(why(check({}, { previousCreatedAt: day(29) }))).toBe("ok");
  });
  it("never twice for one app within 2 h, never twice for one deployment, one in flight at a time", () => {
    expect(why(check({ autoLately: true }))).toBe("auto-rollback within 2 h");
    expect(why(check({ sameDeployBefore: true }))).toBe("already rolled back once");
    expect(why(check({ inFlight: true }))).toBe("another auto-rollback is running");
  });
});

describe("texts", () => {
  it("names the new deploy by its short commit, else its id", () => {
    expect(deployRef({ currentSha: "abcdef1234567", currentId: "dpl_x" })).toBe("abcdef1");
    expect(deployRef({ currentSha: null, currentId: "dpl_new000000012345" })).toBe("dpl_new000000012");
  });
  it("the office reason is ≤ 200 and says it was automatic", () => {
    const r = autoRollbackReason("abcdef1", 30, "x".repeat(400));
    expect(r.startsWith("Automatic: the new deploy abcdef1 errored in the first 30 minutes.")).toBe(true);
    expect(r.length).toBe(200);
  });
});
