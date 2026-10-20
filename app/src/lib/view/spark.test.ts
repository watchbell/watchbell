import { describe, expect, it } from "vitest";
import { sparkPaths, sparkRange } from "./spark";

describe("sparkPaths", () => {
  it("scales like the mockup: 3 px of padding, the lowest value at the bottom", () => {
    expect(sparkPaths([1, 2, 3], 100, 30)).toEqual({
      line: "M0.0,27.0L50.0,15.0L100.0,3.0",
      area: "M0.0,27.0L50.0,15.0L100.0,3.0L100.0,30L0.0,30Z",
      dots: [],
    });
  });
  it("draws a flat line for constant values", () => {
    expect(sparkPaths([5, 5], 10, 30).line).toBe("M0.0,27.0L10.0,27.0");
  });
  it("leaves a gap for an empty bucket", () => {
    expect(sparkPaths([1, null, 3, 3], 30, 30).line).toBe("M0.0,27.0M20.0,3.0L30.0,3.0");
  });
  it("draws nothing without data (fresh install)", () => {
    expect(sparkPaths([null, null], 80, 24)).toEqual({ line: "", area: "", dots: [] });
    expect(sparkPaths([], 80, 24)).toEqual({ line: "", area: "", dots: [] });
  });
  it("keeps a dot at the first or last bucket fully inside the viewBox (it would be clipped by half)", () => {
    const last = sparkPaths([null, null, 4], 20, 30).dots;
    expect(last).toEqual([{ x: 18.5, y: 27 }]);
    expect(sparkPaths([4, null, null], 20, 30).dots).toEqual([{ x: 1.5, y: 27 }]);
  });
  it("marks a lone point with a dot, so the first data point is visible (M11)", () => {
    // fresh install: one number, then nothing yet
    expect(sparkPaths([4, null, null], 20, 30)).toEqual({ line: "M0.0,27.0", area: "", dots: [{ x: 1.5, y: 27 }] });
    // gaps: the isolated point gets a dot, the run of two gets a line and none
    const r = sparkPaths([1, null, 3, 3], 30, 30);
    expect(r.dots).toEqual([{ x: 1.5, y: 27 }]);
    // a single bucket is its own segment too
    expect(sparkPaths([7], 50, 24).dots).toEqual([{ x: 1.5, y: 21 }]);
  });
});

describe("sparkRange (A6: p50 and p95 on one scale)", () => {
  it("spans every series, ignoring gaps; null without numbers", () => {
    expect(sparkRange([100, null, 300], [50, 80])).toEqual({ min: 50, max: 300 });
    expect(sparkRange([null], [])).toBeNull();
  });
  it("a shared range puts equal values at equal heights", () => {
    const r = sparkRange([100, 300], [50, 100])!;
    const y = (line: string, i: number) => line.split(/[ML]/).filter(Boolean)[i].split(",")[1];
    // 100 is the first point of one series and the second of the other: same y on the shared scale.
    expect(y(sparkPaths([100, 300], 100, 40, r).line, 0)).toBe(y(sparkPaths([50, 100], 100, 40, r).line, 1));
  });
});
