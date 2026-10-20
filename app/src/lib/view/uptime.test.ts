import { describe, expect, it } from "vitest";
import { summaryCounts, dayKeys, dayTone, firstBucket, lastDays, mergeDays, series, uptimeBars, uptimePct, wibDay, wibDayStart } from "./uptime";

const H = 3_600_000;

describe("WIB days", () => {
  it("puts 00:30 WIB on the new day, though it is still the day before in UTC", () => {
    expect(wibDay(new Date("2026-10-12T17:30:00Z"))).toBe("2026-10-13");
    expect(wibDay(new Date("2026-10-12T16:59:00Z"))).toBe("2026-10-12");
  });
  it("lists the last n days oldest first, ending with today in WIB, across month ends", () => {
    expect(dayKeys(new Date("2026-10-12T17:30:00Z"), 3)).toEqual(["2026-10-11", "2026-10-12", "2026-10-13"]);
    expect(dayKeys(new Date("2026-03-01T03:00:00Z"), 2)).toEqual(["2026-02-28", "2026-03-01"]);
  });
  it("starts a WIB day at 17:00 UTC the day before", () => {
    expect(wibDayStart("2026-10-13").toISOString()).toBe("2026-10-12T17:00:00.000Z");
  });
});

describe("dayTone (R3)", () => {
  it("is grey without data, green without failures, amber for 1–2, red from 3", () => {
    expect(dayTone(undefined)).toBe("none");
    expect(dayTone({ checks: 0, failures: 0 })).toBe("none");
    expect(dayTone({ checks: 1440, failures: 0 })).toBe("ok");
    expect(dayTone({ checks: 1440, failures: 2 })).toBe("warn");
    expect(dayTone({ checks: 1440, failures: 3 })).toBe("err");
  });
  it("is maintenance (blue) for a day with only maintenance checks, not grey or red (U5)", () => {
    expect(dayTone({ checks: 0, failures: 0, maint: 5 })).toBe("maint");
    expect(dayTone({ checks: 0, failures: 0, maint: 0 })).toBe("none");
    expect(dayTone({ checks: 100, failures: 0, maint: 60 })).toBe("ok");
    expect(dayTone({ checks: 100, failures: 3, maint: 60 })).toBe("err");
  });
});

describe("mergeDays", () => {
  it("adds up rollup and raw rows for the same monitor and day", () => {
    const m = mergeDays([
      { monitorId: "m1", day: "2026-10-12", checks: 600, failures: 1, maint: 30 },
      { monitorId: "m1", day: "2026-10-12", checks: 420, failures: 2, maint: 15 },
      { monitorId: "m2", day: "2026-10-12", checks: 10, failures: 0, maint: 0 },
    ]);
    expect(m.get("m1")?.get("2026-10-12")).toEqual({ day: "2026-10-12", checks: 1020, failures: 3, maint: 45 });
    expect(m.get("m2")?.get("2026-10-12")).toEqual({ day: "2026-10-12", checks: 10, failures: 0, maint: 0 });
  });
});

describe("uptimeBars", () => {
  const now = new Date("2026-10-12T17:30:00Z"); // 00:30 WIB on 13 Oct
  it("draws 90 grey bars for a monitor without data (fresh install)", () => {
    const bars = uptimeBars(undefined, now);
    expect(bars).toHaveLength(90);
    expect(bars.every((b) => b.tone === "none")).toBe(true);
    expect(bars[0].title).toBe("89 days ago · no data");
  });
  it("puts a check made after midnight WIB on today's bar", () => {
    const days = new Map([
      ["2026-10-13", { day: "2026-10-13", checks: 30, failures: 0, maint: 0 }],
      ["2026-10-12", { day: "2026-10-12", checks: 1440, failures: 4, maint: 0 }],
    ]);
    const bars = uptimeBars(days, now);
    expect(bars[89]).toEqual({ day: "2026-10-13", tone: "ok", title: "Today · 0 failed of 30" });
    expect(bars[88]).toEqual({ day: "2026-10-12", tone: "err", title: "1 day ago · 4 failed of 1440" });
  });
  it("draws a day of only maintenance checks as maintenance, not counted (U5)", () => {
    const days = new Map([
      ["2026-10-11", { day: "2026-10-11", checks: 0, failures: 0, maint: 60 }],
      ["2026-10-12", { day: "2026-10-12", checks: 1380, failures: 0, maint: 60 }],
    ]);
    const bars = uptimeBars(days, now);
    expect(bars[87]).toEqual({ day: "2026-10-11", tone: "maint", title: "2 days ago · maintenance, not counted" });
    expect(bars[88]).toEqual({ day: "2026-10-12", tone: "ok", title: "1 day ago · 0 failed of 1380" });
  });
});

describe("uptimePct (R3)", () => {
  it("is (checks − failures) / checks over the window, null without checks", () => {
    expect(uptimePct([])).toBeNull();
    expect(uptimePct([undefined, undefined])).toBeNull();
    expect(uptimePct([{ day: "a", checks: 1000, failures: 2, maint: 0 }, undefined, { day: "b", checks: 1000, failures: 0, maint: 0 }])).toBeCloseTo(99.9, 5);
  });
  it("ignores maintenance checks, and is null with only those (U5)", () => {
    expect(uptimePct([{ day: "a", checks: 1000, failures: 0, maint: 500 }])).toBe(100);
    expect(uptimePct([{ day: "a", checks: 0, failures: 0, maint: 500 }])).toBeNull();
  });
  it("reads only the last n WIB days", () => {
    const days = new Map([
      ["2026-10-13", { day: "2026-10-13", checks: 10, failures: 10, maint: 0 }],
      ["2026-09-01", { day: "2026-09-01", checks: 10, failures: 10, maint: 0 }],
    ]);
    expect(lastDays(days, new Date("2026-10-12T17:30:00Z"), 30).filter(Boolean)).toHaveLength(1);
  });
});

describe("buckets", () => {
  it("ends with the bucket that holds now", () => {
    expect(new Date(firstBucket(new Date("2026-10-12T10:20:00Z"), H, 24)).toISOString()).toBe("2026-10-11T11:00:00.000Z");
    expect(new Date(firstBucket(new Date("2026-10-12T00:10:00Z"), 48 * 60_000, 30)).toISOString()).toBe("2026-10-11T00:48:00.000Z");
  });
  it("places rows by bucket start and leaves gaps empty, or filled for counts", () => {
    const first = Date.parse("2026-10-11T11:00:00Z");
    const out = series([{ t: first, v: 5 }, { t: first + 23 * H, v: 7 }, { t: first - H, v: 9 }], first, H, 24);
    expect(out).toHaveLength(24);
    expect(out[0]).toBe(5);
    expect(out[23]).toBe(7);
    expect(out.slice(1, 23).every((v) => v === null)).toBe(true);
    expect(series([], first, H, 3, 0)).toEqual([0, 0, 0]);
  });
});

describe("uptimeBars with deploys (A1)", () => {
  it("marks the day and names the commit in the tooltip", () => {
    const now = new Date("2026-10-12T15:00:00Z");
    const bars = uptimeBars(undefined, now, 3, new Map([["2026-10-12", "c8202c1"]]));
    expect(bars[2].deploy).toBe("c8202c1");
    expect(bars[2].title).toMatch(/ · deployed c8202c1$/);
    expect(bars[1].deploy).toBeUndefined();
  });
});

describe("summaryCounts", () => {
  it("counts up, degraded, down, maintenance and paused monitors, heartbeats included", () => {
    expect(summaryCounts([
      { state: "ok" }, { state: "ok" }, { state: "warn" }, { state: "err" }, { state: "maint" },
      { state: "paused" }, { state: "off" }, { state: "unknown" },
    ])).toEqual({ ok: 2, warn: 1, err: 1, maint: 1, paused: 2 });
  });
  it("leaves out monitors of an app removed from Vercel, and monitors still waiting for a first check", () => {
    expect(summaryCounts([{ state: "off", appGone: true }, { state: "unknown" }])).toEqual({ ok: 0, warn: 0, err: 0, maint: 0, paused: 0 });
  });
  it("counts a paused heartbeat as paused, not as down (state is already what monitorStatus decided)", () => {
    expect(summaryCounts([{ state: "paused" }, { state: "err" }])).toEqual({ ok: 0, warn: 0, err: 1, maint: 0, paused: 1 });
  });
});
