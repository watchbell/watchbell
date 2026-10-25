import { describe, expect, it } from "vitest";
import { CUT_TRIES, parseSlot, SLOT_MAX_RUNS, slotComplete } from "./slot";

const SLOT = "2026-10-24T10:36:00.000Z";

// Fix round 1 (review important 1): the 6-hourly slot continues in the next minute runs until both parts went through
// their whole list (oldest first, never the same item twice in a slot).
describe("the security slot's progress", () => {
  it("starts fresh for a new slot, and reads what this slot already did", () => {
    expect(parseSlot(null, SLOT)).toEqual({ slot: SLOT, runs: 0, next: [], repos: [], cut: {}, nextDone: false, depsDone: false });
    expect(parseSlot({ slot: "2026-10-24T04:36:00.000Z", runs: 3, next: ["a"], repos: ["r"], nextDone: true, depsDone: true }, SLOT)).toEqual(parseSlot(null, SLOT));
    expect(parseSlot({ slot: SLOT, runs: 2, next: ["a", 3], repos: ["r"], cut: { b: 1, c: "x", d: 9 }, nextDone: true, depsDone: "x" }, SLOT))
      .toEqual({ slot: SLOT, runs: 2, next: ["a"], repos: ["r"], cut: { b: 1, d: CUT_TRIES }, nextDone: true, depsDone: false });
    expect(CUT_TRIES).toBe(2);
  });

  it("is complete when both parts went through their lists (a paused part doesn't count), or after SLOT_MAX_RUNS runs", () => {
    const p = parseSlot(null, SLOT);
    expect(slotComplete({ ...p, nextDone: true }, true, true)).toBe(false);
    expect(slotComplete({ ...p, nextDone: true, depsDone: true }, true, true)).toBe(true);
    expect(slotComplete({ ...p, nextDone: true }, true, false)).toBe(true);
    expect(slotComplete({ ...p, depsDone: true }, false, true)).toBe(true);
    expect(slotComplete({ ...p, runs: SLOT_MAX_RUNS }, true, true)).toBe(true);
  });
});
