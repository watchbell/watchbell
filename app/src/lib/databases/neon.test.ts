import { describe, expect, it } from "vitest";
import { autoscalingText, cuHours, endpointState, neonProjectState } from "./neon";

const ep = (state: string, extra: Partial<{ pendingState: string | null; disabled: boolean }> = {}) => ({ state, pendingState: null, disabled: false, ...extra });

describe("endpointState", () => {
  it.each([
    [ep("active"), "ok", "Active"], [ep("idle"), "idle", "Idle"], [ep("init"), "build", "Starting"],
    [ep("idle", { pendingState: "active" }), "build", "Starting"], [ep("idle", { disabled: true }), "err", "Suspended"], [ep("weird"), "unknown", "Unknown"],
  ])("%o → %s %s", (e, state, label) => expect(endpointState(e)).toEqual({ state, label }));
});

describe("neonProjectState", () => {
  it("is active if any compute runs, idle when all scaled to zero", () => {
    expect(neonProjectState({ endpoints: [ep("idle"), ep("active")], computeSeconds: 0 })).toEqual({ state: "ok", label: "Active" });
    expect(neonProjectState({ endpoints: [ep("idle"), ep("idle")], computeSeconds: 0 })).toEqual({ state: "idle", label: "Idle" });
  });
  it("is down when a compute is suspended or the 100 CU-hours are used up", () => {
    expect(neonProjectState({ endpoints: [ep("idle", { disabled: true })], computeSeconds: 0 })).toEqual({ state: "err", label: "Compute suspended" });
    expect(neonProjectState({ endpoints: [ep("idle")], computeSeconds: 100 * 3600 })).toEqual({ state: "err", label: "CU-hours used up" });
  });
  it("says so when a project has no compute", () => {
    expect(neonProjectState({ endpoints: [], computeSeconds: null })).toEqual({ state: "unknown", label: "No compute" });
  });
});

describe("cuHours / autoscalingText", () => {
  it("shows CU-hours with one decimal and the autoscaling range", () => {
    expect(cuHours(148_320)).toBe(41.2);
    expect(autoscalingText(0.25, 2)).toBe("0.25–2 CU");
    expect(autoscalingText(0.25, 0.25)).toBe("0.25 CU");
  });
});
