import { describe, expect, it } from "vitest";
import type { DayCount } from "@/lib/view/uptime";
import { buildReportModel, dayTone, type ReportInput } from "./model";

const OCT = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
const full = (fail: Record<string, number> = {}, from = "2026-10-01"): Map<string, DayCount> =>
  new Map(OCT.filter((d) => d >= from).map((day) => [day, { day, checks: 1440, failures: fail[day] ?? 0, maint: 0 }]));

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  month: "2026-10", zone: "Asia/Jakarta", generatedAt: new Date("2026-11-01T00:00:00Z"),
  sites: [{ monitorId: "m1", name: "Toko utama", intervalS: 60, firstDay: "2026-10-01", days: full({ "2026-10-23": 22, "2026-10-09": 3 }), p50ByDay: new Map(OCT.map((d) => [d, 280])) }],
  incidents: [
    { monitorId: "m1", kind: "down", startedAt: new Date("2026-10-22T19:14:00Z"), resolvedAt: new Date("2026-10-22T19:36:00Z"), endedBy: "resolved" },
    { monitorId: "m1", kind: "slow", startedAt: new Date("2026-10-09T06:40:00Z"), resolvedAt: new Date("2026-10-09T06:44:00Z"), endedBy: "resolved" },
  ],
  deploys: [{ monitorId: "m1", ok: 13, failed: 1, firstDay: "2026-10-01" }],
  dataFrom: { uptime: null, updates: null },
  ...over,
});

describe("dayTone (1.7 report calendar)", () => {
  it("is down from 5 minutes of failures, a short outage below that, and none without checks", () => {
    expect(dayTone({ day: "d", checks: 1440, failures: 5, maint: 0 }, 60)).toBe("down");
    expect(dayTone({ day: "d", checks: 1440, failures: 4, maint: 0 }, 60)).toBe("warn");
    expect(dayTone({ day: "d", checks: 288, failures: 1, maint: 0 }, 300)).toBe("down");
    expect(dayTone({ day: "d", checks: 1440, failures: 0, maint: 30 }, 60)).toBe("ok");
    expect(dayTone(undefined, 60)).toBe("none");
    expect(dayTone({ day: "d", checks: 0, failures: 0, maint: 0 }, 60)).toBe("none");
  });
});

describe("buildReportModel", () => {
  it("colours the month, explains the bad days and sums the month", () => {
    const m = buildReportModel(input());
    expect(m.days).toHaveLength(31);
    expect(m.days[22]).toEqual({ day: "2026-10-23", tone: "down" });
    expect(m.days[8]).toEqual({ day: "2026-10-09", tone: "warn" });
    expect(m.days[0].tone).toBe("ok");
    expect(m.summary.uptimePct).toBeCloseTo(99.944, 2);
    expect(m.summary.p50Ms).toBe(280);
    expect(m.summary.updates).toEqual({ ok: 13, failed: 1 });
    expect(m.badDays.map((b) => [b.day, b.tone])).toEqual([["2026-10-09", "warn"], ["2026-10-23", "down"]]);
    expect(m.badDays[1].lines[0]).toMatchObject({ site: "Toko utama", kind: "down", minutes: 22, endedBy: "resolved" });
    expect(m.sites[0]).toMatchObject({ name: "Toko utama", downMinutes: 25, p50Ms: 280, dataFrom: null });
    expect(m.updates).toEqual([{ name: "Toko utama", ok: 13, failed: 1 }]);
    expect(m.responseSeries[0].values).toHaveLength(31);
  });

  it("partial month: a site that started on the 15th counts only checked days and says so", () => {
    const m = buildReportModel(input({
      sites: [{ monitorId: "m1", name: "Toko utama", intervalS: 60, firstDay: "2026-10-15", days: full({}, "2026-10-15"), p50ByDay: new Map() }],
      incidents: [], deploys: [],
    }));
    expect(m.sites[0].dataFrom).toBe("2026-10-15");
    expect(m.days[0].tone).toBe("none");
    expect(m.days[14].tone).toBe("ok");
    expect(m.summary.uptimePct).toBe(100);
    expect(m.summary.p50Ms).toBeNull();
  });

  it("has no uptime without any checks, never a made-up 0% or 100%", () => {
    const m = buildReportModel(input({ sites: [{ monitorId: "m1", name: "A", intervalS: 60, firstDay: null, days: new Map(), p50ByDay: new Map() }], incidents: [], deploys: [] }));
    expect(m.summary.uptimePct).toBeNull();
    expect(m.sites[0].uptimePct).toBeNull();
    expect(m.days.every((d) => d.tone === "none")).toBe(true);
  });

  it("names a site only by the display name it was given", () => {
    const m = buildReportModel(input());
    expect(JSON.stringify(m)).not.toMatch(/m1|https?:/);
  });

  it("takes the worst site's tone for a day", () => {
    const two = input({ sites: [input().sites[0], { monitorId: "m2", name: "Toko", intervalS: 60, firstDay: "2026-10-01", days: full({ "2026-10-02": 9 }), p50ByDay: new Map() }] });
    expect(buildReportModel(two).days[1].tone).toBe("down");
  });
});

// Watchbell 1.7.1 (review M-1, M-2, M-3, M-5, M-6).
describe("buildReportModel (1.7.1)", () => {
  const clean = (over: Partial<ReportInput> = {}) => input({ sites: [{ ...input().sites[0], days: full() }], incidents: [], ...over });

  it("cuts an open incident at the month end of the install zone", () => {
    const m = buildReportModel(clean({
      generatedAt: new Date("2026-11-05T00:00:00Z"),
      incidents: [{ monitorId: "m1", kind: "down", startedAt: new Date("2026-10-31T16:00:00Z"), resolvedAt: null, endedBy: "open" }],
    }));
    expect(m.incidents[0].minutes).toBe(60);
  });

  it("slow incident spanning two days turns both amber, and only those", () => {
    const m = buildReportModel(clean({
      incidents: [{ monitorId: "m1", kind: "slow", startedAt: new Date("2026-10-12T16:30:00Z"), resolvedAt: new Date("2026-10-12T17:30:00Z"), endedBy: "resolved" }],
    }));
    expect(m.days[11].tone).toBe("warn");
    expect(m.days[12].tone).toBe("warn");
    expect(m.days[13].tone).toBe("ok");
    expect(m.days[10].tone).toBe("ok");
  });

  it("a day that is down stays down when it also had a slow incident", () => {
    const m = buildReportModel(input({
      incidents: [{ monitorId: "m1", kind: "slow", startedAt: new Date("2026-10-23T03:00:00Z"), resolvedAt: new Date("2026-10-23T03:20:00Z"), endedBy: "resolved" }],
    }));
    expect(m.days[22].tone).toBe("down");
  });

  it("explains a bad day without an incident", () => {
    const m = buildReportModel(clean({ sites: [{ ...input().sites[0], days: full({ "2026-10-09": 3 }) }] }));
    expect(m.dayLines).toEqual([{ day: "2026-10-09", site: "Toko utama", tone: "warn", downMinutes: 3, slow: false }]);
  });

  it("day lines combine slow and down for one site, ordered by day", () => {
    const m = buildReportModel(input({
      incidents: [{ monitorId: "m1", kind: "slow", startedAt: new Date("2026-10-23T03:00:00Z"), resolvedAt: new Date("2026-10-23T03:20:00Z"), endedBy: "resolved" }],
    }));
    expect(m.dayLines).toEqual([
      { day: "2026-10-09", site: "Toko utama", tone: "warn", downMinutes: 3, slow: false },
      { day: "2026-10-23", site: "Toko utama", tone: "down", downMinutes: 22, slow: true },
    ]);
  });

  it("a slow-only day is a line without down minutes", () => {
    const m = buildReportModel(clean({
      incidents: [{ monitorId: "m1", kind: "slow", startedAt: new Date("2026-10-19T03:00:00Z"), resolvedAt: new Date("2026-10-19T03:20:00Z"), endedBy: "resolved" }],
    }));
    expect(m.dayLines).toEqual([{ day: "2026-10-19", site: "Toko utama", tone: "warn", downMinutes: 0, slow: true }]);
  });

  it("lists the distinct check intervals", () => {
    const s = input().sites[0];
    const m = buildReportModel(input({ sites: [{ ...s, intervalS: 300 }, { ...s, monitorId: "m2", name: "B", intervalS: 60 }, { ...s, monitorId: "m3", name: "C", intervalS: 300 }] }));
    expect(m.intervals).toEqual([60, 300]);
  });

  it("summary data-from is the earliest site start after the 1st", () => {
    const s = input().sites[0];
    const late = buildReportModel(input({ sites: [{ ...s, firstDay: "2026-10-20", days: full({}, "2026-10-20") }, { ...s, monitorId: "m2", name: "B", firstDay: "2026-10-12", days: full({}, "2026-10-12") }] }));
    expect(late.summary.dataFrom).toBe("2026-10-12");
    const onTime = buildReportModel(input({ sites: [{ ...s, firstDay: "2026-10-20" }, { ...s, monitorId: "m2", name: "B", firstDay: "2026-10-01" }] }));
    expect(onTime.summary.dataFrom).toBeNull();
  });
});
