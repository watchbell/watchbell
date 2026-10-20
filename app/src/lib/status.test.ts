import { describe, expect, it } from "vitest";
import { clampPct, STATE_TONE, STATES } from "./status";

describe("status", () => {
  it("has a tone for every state", () => {
    expect(Object.keys(STATE_TONE).sort()).toEqual([...STATES].sort());
  });
  it("has the maintenance state, toned like a brand state", () => {
    expect(STATES).toContain("maint");
    expect(STATE_TONE.maint).toBe("text-brand");
  });
  it("clamps progress values", () => {
    expect(clampPct(-5)).toBe(0);
    expect(clampPct(42.4)).toBe(42.4);
    expect(clampPct(250)).toBe(100);
    expect(clampPct(Number.NaN)).toBe(0);
  });
});
