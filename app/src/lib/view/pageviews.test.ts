import { describe, expect, it } from "vitest";
import { isStale, pageViewBars, pageViewsOf, pageViewsUnavailable, STALE_MS, storedPageViews } from "./pageviews";

const READ = new Date("2026-10-13T12:40:00Z");
const stored = (o: Record<string, unknown> = {}) => ({ pageviews: { enabled: true, total24h: 12, visitors24h: 5, readAt: READ.toISOString(), hourly: [], ...o } });

describe("storedPageViews", () => {
  it("stores the off state with just the read time", () => {
    expect(storedPageViews({ ok: true, enabled: false }, READ)).toEqual({ enabled: false, readAt: READ.toISOString() });
  });
  it("stores totals and [isoHour, views] pairs, at most 24", () => {
    const hourly = Array.from({ length: 26 }, (_, i) => ({ at: new Date(Date.UTC(2026, 9, 12, i)), views: i }));
    const s = storedPageViews({ ok: true, enabled: true, total: 300, visitors: 90, hourly }, READ);
    expect(s).toMatchObject({ enabled: true, total24h: 300, visitors24h: 90, readAt: READ.toISOString() });
    if (!s.enabled) throw new Error("enabled");
    expect(s.hourly).toHaveLength(24);
    expect(s.hourly[0]).toEqual(["2026-10-12T02:00:00.000Z", 2]);
    expect(s.hourly[23]).toEqual(["2026-10-13T01:00:00.000Z", 25]);
  });
});

describe("pageViewsOf", () => {
  it("is null until the first read, and for anything that isn't the stored shape", () => {
    for (const d of [null, undefined, {}, { code: 200 }, { pageviews: null }, { pageviews: "x" }, { pageviews: { enabled: true } },
      { pageviews: { enabled: "yes", readAt: READ.toISOString() } }, stored({ readAt: "nope" }), stored({ total24h: "12" }), stored({ visitors24h: -1 })]) {
      expect(pageViewsOf(d), JSON.stringify(d)).toBeNull();
    }
  });

  it("reads the off state", () => {
    expect(pageViewsOf({ pageviews: { enabled: false, readAt: READ.toISOString() } })).toEqual({ enabled: false, readAt: READ });
  });

  it("lays the hours into 24 slots ending at the hour of the read, 0 where Vercel reported nothing", () => {
    const v = pageViewsOf(stored({ hourly: [["2026-10-13T12:00:00.000Z", 4], ["2026-10-13T10:00:00.000Z", 3], ["2026-10-11T00:00:00.000Z", 50]] }));
    if (!v?.enabled) throw new Error("enabled");
    expect(v).toMatchObject({ total: 12, visitors: 5, readAt: READ });
    expect(v.hours).toHaveLength(24);
    expect(v.hours[0].at).toEqual(new Date("2026-10-12T13:00:00Z"));
    expect(v.hours[23]).toEqual({ at: new Date("2026-10-13T12:00:00Z"), views: 4 });
    expect(v.hours[21]).toEqual({ at: new Date("2026-10-13T10:00:00Z"), views: 3 });
    expect(v.hours[22].views).toBe(0);
    expect(v.hours.reduce((s, h) => s + h.views, 0)).toBe(7); // the hour outside the window is dropped
  });

  it("keeps an enabled project with 0 views as 0, not null", () => {
    const v = pageViewsOf(stored({ total24h: 0, visitors24h: 0 }));
    expect(v).toMatchObject({ enabled: true, total: 0, visitors: 0 });
    if (!v?.enabled) throw new Error("enabled");
    expect(v.hours.every((h) => h.views === 0)).toBe(true);
  });

  it("skips malformed hourly entries instead of failing", () => {
    const v = pageViewsOf(stored({ hourly: [["2026-10-13T12:00:00.000Z", 2], "x", [1, 2], ["bad", 3], ["2026-10-13T11:00:00.000Z", "9"], null] }));
    if (!v?.enabled) throw new Error("enabled");
    expect(v.hours.reduce((s, h) => s + h.views, 0)).toBe(2);
  });
});

describe("pageViewBars", () => {
  const hours = (views: number[]) => views.map((n, i) => ({ at: new Date(Date.UTC(2026, 9, 13, i)), views: n }));
  it("scales each hour to the busiest one, with a tooltip in WIB", () => {
    const bars = pageViewBars(hours([0, 5, 10]));
    expect(bars.map((b) => b.pct)).toEqual([0, 50, 100]);
    expect(bars[1]).toMatchObject({ key: "2026-10-13T01:00:00.000Z", title: "08:00 · 5 views" });
    expect(bars[2].title).toBe("09:00 · 10 views");
  });
  it("says '1 view' and '0 views', and gives a small hour a visible sliver (never rounded to nothing)", () => {
    const bars = pageViewBars(hours([1, 0, 1000]));
    expect(bars[0].title).toBe("07:00 · 1 view");
    expect(bars[1].title).toBe("08:00 · 0 views");
    expect(bars[0].pct).toBe(4);
    expect(bars[1].pct).toBe(0);
  });
  it("draws all zeros as zero-height bars, not NaN", () => {
    expect(pageViewBars(hours([0, 0])).map((b) => b.pct)).toEqual([0, 0]);
  });
});

describe("isStale", () => {
  const readAt = new Date("2026-10-13T10:00:00Z");
  it("is stale only when the last read is more than 2 hours old", () => {
    expect(STALE_MS).toBe(7_200_000);
    expect(isStale(readAt, new Date("2026-10-13T11:00:00Z"))).toBe(false);
    expect(isStale(readAt, new Date("2026-10-13T12:00:00Z"))).toBe(false);
    expect(isStale(readAt, new Date("2026-10-13T12:01:00Z"))).toBe(true);
    expect(isStale(readAt, new Date("2026-10-14T10:00:00Z"))).toBe(true);
  });
  it("a read time in the future (clock skew) is not stale", () => {
    expect(isStale(new Date("2026-10-13T10:05:00Z"), new Date("2026-10-13T10:00:00Z"))).toBe(false);
  });
});

describe("unknown visitors", () => {
  it("is stored and read back as null, with the total kept", () => {
    const s = storedPageViews({ ok: true, enabled: true, total: 10, visitors: null, hourly: [] }, READ);
    expect(s).toMatchObject({ enabled: true, total24h: 10, visitors24h: null });
    const v = pageViewsOf({ pageviews: JSON.parse(JSON.stringify(s)) });
    expect(v).toMatchObject({ enabled: true, total: 10, visitors: null });
  });
  it("still rejects a visitors value that is neither a count nor null", () => {
    expect(pageViewsOf(stored({ visitors24h: "5" }))).toBeNull();
  });
});

describe("pageViewsUnavailable", () => {
  const ok = { gone: false, teamId: "team_a", accountOk: true, hasProductionDeploy: true };
  it("is null for an app the task reads", () => {
    expect(pageViewsUnavailable(ok)).toBeNull();
  });
  it("says the app isn't in a connected Vercel account when it is gone, has no team id, or its account isn't ok", () => {
    for (const o of [{ gone: true }, { teamId: null }, { teamId: "" }, { accountOk: false }]) {
      expect(pageViewsUnavailable({ ...ok, ...o }), JSON.stringify(o)).toBe("Not read: this app isn't in a connected Vercel account.");
    }
  });
  it("says there is no production deployment yet", () => {
    expect(pageViewsUnavailable({ ...ok, hasProductionDeploy: false })).toBe("Not read: this app has no production deployment yet.");
  });
});
