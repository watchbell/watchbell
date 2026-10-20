import { describe, expect, it } from "vitest";
import { autoPauseRisk, freeSlots, lastTraffic, restoreDeadline, sizeDue, supabaseState, usesSlot } from "./supabase";

const now = new Date("2026-10-12T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

describe("supabaseState", () => {
  it.each([
    ["ACTIVE_HEALTHY", "ok", "Active healthy"], ["ACTIVE_UNHEALTHY", "warn", "Active unhealthy"], ["INACTIVE", "paused", "Paused"],
    ["RESTORING", "build", "Restoring"], ["COMING_UP", "build", "Starting"], ["PAUSING", "build", "Pausing"], ["GOING_DOWN", "build", "Pausing"],
    ["RESTARTING", "build", "Restarting"], ["UPGRADING", "build", "Upgrading"], ["RESIZING", "build", "Resizing"],
    ["RESTORE_FAILED", "err", "Restore failed"], ["PAUSE_FAILED", "err", "Pause failed"], ["INIT_FAILED", "err", "Setup failed"],
    ["REMOVED", "off", "Removed"], ["UNKNOWN", "unknown", "Unknown"], ["SOMETHING_NEW", "unknown", "Unknown"],
  ])("%s → %s %s", (status, state, label) => expect(supabaseState(status)).toEqual({ state, label }));
});

describe("freeSlots", () => {
  it("counts every non-paused project in free orgs against 2 (D3)", () => {
    expect(usesSlot("INACTIVE")).toBe(false);
    expect(usesSlot("RESTORING")).toBe(true);
    expect(freeSlots([{ status: "ACTIVE_HEALTHY", freeOrg: true }, { status: "INACTIVE", freeOrg: true }, { status: "ACTIVE_HEALTHY", freeOrg: false }]))
      .toEqual({ used: 1, total: 2, left: 1, planUnknown: false });
    expect(freeSlots([{ status: "ACTIVE_HEALTHY", freeOrg: null }, { status: "COMING_UP", freeOrg: true }, { status: "ACTIVE_HEALTHY", freeOrg: true }]))
      .toEqual({ used: 3, total: 2, left: 0, planUnknown: true });
  });
});

describe("lastTraffic", () => {
  it("is the latest bucket with any request", () => {
    expect(lastTraffic([{ at: daysAgo(3), total: 2 }, { at: daysAgo(2), total: 0 }, { at: daysAgo(5), total: 9 }])).toEqual(daysAgo(3));
    expect(lastTraffic([{ at: daysAgo(1), total: 0 }])).toBeNull();
  });
});

describe("autoPauseRisk", () => {
  const base = { status: "ACTIVE_HEALTHY", pausedSince: null, pausedBeforeSeen: false, trafficCheckedAt: now, now };
  it("is low with traffic in the last 4 days", () => {
    expect(autoPauseRisk({ ...base, lastTrafficAt: daysAgo(3.9) })).toEqual({ state: "ok", text: "Low", note: null });
  });
  it("counts down to Supabase's 7 idle days from day 4", () => {
    expect(autoPauseRisk({ ...base, lastTrafficAt: daysAgo(4) })).toEqual({ state: "warn", text: "Pauses in ~3 days", note: "Supabase pauses free projects after 7 idle days" });
    expect(autoPauseRisk({ ...base, lastTrafficAt: daysAgo(6.5) })).toMatchObject({ state: "warn", text: "Pauses in ~1 day" });
  });
  it("says it may pause any time after 7 idle days or with no traffic in the 7-day window", () => {
    expect(autoPauseRisk({ ...base, lastTrafficAt: null })).toMatchObject({ state: "err", text: "May pause any time" });
  });
  it("shows the restore deadline for a paused project: 1 year after the pause (D4)", () => {
    expect(restoreDeadline(new Date("2026-10-12T02:12:00Z"))).toEqual(new Date("2027-10-12T02:12:00Z"));
    expect(autoPauseRisk({ ...base, status: "INACTIVE", lastTrafficAt: null, pausedSince: new Date("2026-10-12T02:12:00Z") }))
      .toEqual({ state: "paused", text: "Restore by 12 Oct 2027", note: "Paused free projects can be restored for 1 year" });
    expect(autoPauseRisk({ ...base, status: "INACTIVE", lastTrafficAt: null, pausedSince: daysAgo(1), pausedBeforeSeen: true }))
      .toEqual({ state: "paused", text: "Restore within 1 year of pausing", note: "Paused before the console saw it" });
  });
  it("is unknown before the first traffic read and for projects that are not active", () => {
    expect(autoPauseRisk({ ...base, lastTrafficAt: null, trafficCheckedAt: null })).toEqual({ state: "unknown", text: "—", note: null });
    expect(autoPauseRisk({ ...base, status: "RESTORING", lastTrafficAt: null })).toEqual({ state: "unknown", text: "—", note: null });
  });
});

describe("sizeDue (D1: never keep a dormant project awake)", () => {
  it("reads the size once a day, only for a healthy project with API traffic in the last 24 h", () => {
    expect(sizeDue({ status: "ACTIVE_HEALTHY", lastTrafficAt: daysAgo(0.5), sizeAt: daysAgo(1.1), now })).toBe(true);
    expect(sizeDue({ status: "ACTIVE_HEALTHY", lastTrafficAt: daysAgo(0.5), sizeAt: daysAgo(0.5), now })).toBe(false);
    expect(sizeDue({ status: "ACTIVE_HEALTHY", lastTrafficAt: daysAgo(2), sizeAt: null, now })).toBe(false);
    expect(sizeDue({ status: "ACTIVE_UNHEALTHY", lastTrafficAt: daysAgo(0.1), sizeAt: null, now })).toBe(false);
    expect(sizeDue({ status: "ACTIVE_HEALTHY", lastTrafficAt: null, sizeAt: null, now })).toBe(false);
  });
});
