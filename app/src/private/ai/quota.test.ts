import { describe, expect, it } from "vitest";
import { formatResetsIn, isLimited, ownObservations, ownWindows, quotaGroups, windowBounds } from "./quota";

const now = new Date("2026-10-15T10:20:30.000Z"); // a Thursday

describe("windows", () => {
  it("minute, day (00:00 UTC) and week (Monday 00:00 UTC)", () => {
    expect(windowBounds("minute", now)).toEqual({ start: new Date("2026-10-15T10:20:00Z"), end: new Date("2026-10-15T10:21:00Z") });
    expect(windowBounds("day", now)).toEqual({ start: new Date("2026-10-15T00:00:00Z"), end: new Date("2026-10-16T00:00:00Z") });
    expect(windowBounds("week", now)).toEqual({ start: new Date("2026-10-12T00:00:00Z"), end: new Date("2026-10-19T00:00:00Z") });
    expect(windowBounds("week", new Date("2026-10-12T00:00:00Z")).start).toEqual(new Date("2026-10-12T00:00:00Z"));
    expect(ownWindows([{ metric: "requests", scope: "all", limit: 10, window: "day" }], now)[0].resetAt).toEqual(new Date("2026-10-16T00:00:00Z"));
  });
  it("formats the time to reset", () => {
    expect(formatResetsIn(41_000)).toBe("41s");
    expect(formatResetsIn(9 * 3600_000 + 12 * 60_000)).toBe("9h 12m");
    expect(formatResetsIn(28 * 3600_000)).toBe("1d 4h");
    expect(formatResetsIn(-5)).toBe("0s");
  });
});

describe("own counts", () => {
  const limits = [
    { metric: "requests", scope: "all", limit: 1000, window: "day" as const },
    { metric: "tokens", scope: "gemini-3.8-flash", limit: 2_000_000, window: "week" as const },
    { metric: "tokens", scope: "gemini-2.5-pro", limit: 5, window: "minute" as const },
  ];
  it("counts a request against every matching limit", () => {
    expect(ownObservations("p1", limits, "gemini-3.8-flash", 1200, now)).toEqual([
      { providerId: "p1", scope: "all", metric: "requests:day", limit: 1000, remaining: null, used: 1, resetAt: new Date("2026-10-16T00:00:00Z"), source: "own" },
      { providerId: "p1", scope: "gemini-3.8-flash", metric: "tokens:week", limit: 2_000_000, remaining: null, used: 1200, resetAt: new Date("2026-10-19T00:00:00Z"), source: "own" },
    ]);
  });
  it("groups rows by provider and model family, with limits that saw no call yet", () => {
    const g = quotaGroups([
      { providerId: "p1", scope: "all", metric: "requests:day", windowStart: new Date("2026-10-15T00:00:00Z"), used: 250, limit: 1000, remaining: null, resetAt: new Date("2026-10-16T00:00:00Z"), source: "own" },
    ], [{ id: "p1", kind: "gemini", name: "Google Gemini", limits: limits.slice(0, 2) }], now);
    expect(g).toEqual([
      { group: "Google Gemini · all models", provider: "gemini", providerId: "p1", rows: [{ label: "Daily request limit (you entered)", pctLeft: 75, resetsIn: "13h 39m", source: "own", used: 250, limit: 1000, limited: false }] },
      { group: "Google Gemini · gemini-3.8-flash", provider: "gemini", providerId: "p1", rows: [{ label: "Weekly token limit (you entered)", pctLeft: 100, resetsIn: "3d 13h", source: "own", used: 0, limit: 2_000_000, limited: false }] },
    ]);
  });
  it("an own row from an earlier window shows as reset", () => {
    const g = quotaGroups([
      { providerId: "p1", scope: "all", metric: "requests:day", windowStart: new Date("2026-10-14T00:00:00Z"), used: 1000, limit: 1000, remaining: null, resetAt: new Date("2026-10-15T00:00:00Z"), source: "own" },
    ], [{ id: "p1", kind: "gemini", name: "Google Gemini", limits: limits.slice(0, 1) }], now);
    expect(g[0].rows[0]).toMatchObject({ pctLeft: 100, used: 0, limited: false });
  });
  it("is limited when nothing is left before the reset", () => {
    expect(isLimited({ used: 5, limit: 5, remaining: null, resetAt: new Date(now.getTime() + 1000) }, now)).toBe(true);
    expect(isLimited({ used: null, limit: 30, remaining: 0, resetAt: new Date(now.getTime() + 1000) }, now)).toBe(true);
    expect(isLimited({ used: null, limit: 30, remaining: 0, resetAt: new Date(now.getTime() - 1) }, now)).toBe(false);
  });
});
