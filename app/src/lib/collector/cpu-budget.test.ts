import { describe, expect, it } from "vitest";
import { addRunCpu, collectMinGapMs, CPU_DAY_WARN_MS, DEFAULT_MIN_GAP_MIN, tooSoon } from "./cpu-budget";

const NOW = new Date("2026-10-28T12:30:00.000Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

describe("collectMinGapMs", () => {
  it("defaults to 10 minutes and follows WATCHBELL_COLLECT_MIN_GAP_MIN (0 turns it off)", () => {
    expect(collectMinGapMs({})).toBe(DEFAULT_MIN_GAP_MIN * 60_000);
    expect(collectMinGapMs({ WATCHBELL_COLLECT_MIN_GAP_MIN: "25" })).toBe(25 * 60_000);
    expect(collectMinGapMs({ WATCHPOST_COLLECT_MIN_GAP_MIN: "3" })).toBe(3 * 60_000);
    expect(collectMinGapMs({ WATCHBELL_COLLECT_MIN_GAP_MIN: "0" })).toBe(0);
  });
  it("ignores a value that isn't a number of minutes", () => {
    for (const v of ["abc", "-5"]) expect(collectMinGapMs({ WATCHBELL_COLLECT_MIN_GAP_MIN: v })).toBe(DEFAULT_MIN_GAP_MIN * 60_000);
  });
});

describe("tooSoon", () => {
  const gap = 10 * 60_000;
  it("refuses a scheduled call within the gap, allows one after it or without a previous run", () => {
    expect(tooSoon(ago(1), NOW, gap)).toBe(true);
    expect(tooSoon(ago(9.9), NOW, gap)).toBe(true);
    expect(tooSoon(ago(10), NOW, gap)).toBe(false);
    expect(tooSoon(ago(30), NOW, gap)).toBe(false);
    expect(tooSoon(null, NOW, gap)).toBe(false);
  });
  it("never refuses when the gap is off", () => expect(tooSoon(ago(0.1), NOW, 0)).toBe(false));
});

describe("addRunCpu", () => {
  it("adds a run to today's total and starts again on a new UTC day", () => {
    const one = addRunCpu(null, 700, NOW).next;
    expect(one).toEqual({ day: "2026-10-28", ms: 700, runs: 1, warned: false });
    expect(addRunCpu(one, 300.4, NOW).next).toEqual({ day: "2026-10-28", ms: 1000, runs: 2, warned: false });
    expect(addRunCpu(one, 500, new Date("2026-10-29T00:00:01.000Z")).next).toEqual({ day: "2026-10-29", ms: 500, runs: 1, warned: false });
  });
  it("crosses the warning line once a day", () => {
    const near = { day: "2026-10-28", ms: CPU_DAY_WARN_MS - 100, runs: 300, warned: false };
    const first = addRunCpu(near, 200, NOW);
    expect(first.crossed).toBe(true);
    expect(first.next.warned).toBe(true);
    expect(addRunCpu(first.next, 200, NOW).crossed).toBe(false);
  });
  it("reads a damaged or foreign value as an empty day and ignores a bad sample", () => {
    expect(addRunCpu({ day: "2026-10-28", ms: "x" }, 100, NOW).next).toEqual({ day: "2026-10-28", ms: 100, runs: 1, warned: false });
    expect(addRunCpu(null, Number.NaN, NOW).next.ms).toBe(0);
  });
});
