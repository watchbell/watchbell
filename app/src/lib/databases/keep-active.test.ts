import { describe, expect, it } from "vitest";
import { AUTO_RESTORE_EVERY_MS, autoRestoreDecision, KEEP_ALIVE_AFTER_DAYS, keepAliveDue } from "./keep-active";

const DAY = 86_400_000;
const now = new Date("2026-10-13T20:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("keepAliveDue (A8)", () => {
  const base = { status: "ACTIVE_HEALTHY", keep: true, lastTraffic: ago(5 * DAY), trackedSince: ago(30 * DAY) };
  it("is due from exactly 5 days without API traffic, not a minute before", () => {
    expect(KEEP_ALIVE_AFTER_DAYS).toBe(5);
    expect(keepAliveDue(base, now)).toBe(true);
    expect(keepAliveDue({ ...base, lastTraffic: ago(5 * DAY - 60_000) }, now)).toBe(false);
    expect(keepAliveDue({ ...base, lastTraffic: ago(6 * DAY) }, now)).toBe(true);
  });
  it("counts unknown traffic from when the console started tracking the project", () => {
    expect(keepAliveDue({ ...base, lastTraffic: null, trackedSince: ago(5 * DAY) }, now)).toBe(true);
    expect(keepAliveDue({ ...base, lastTraffic: null, trackedSince: ago(4 * DAY) }, now)).toBe(false);
  });
  it("only for a kept, active healthy project", () => {
    expect(keepAliveDue({ ...base, keep: false }, now)).toBe(false);
    for (const status of ["INACTIVE", "ACTIVE_UNHEALTHY", "RESTORING", "COMING_UP", "PAUSING", "UNKNOWN", ""]) expect(keepAliveDue({ ...base, status }, now)).toBe(false);
  });
});

describe("autoRestoreDecision (A8)", () => {
  const base = { status: "INACTIVE", autoRestore: true, lastAutoRestoreAt: null, slotsLeft: 1, accessDenied: false };
  it("acts on a paused project with Auto-restore on, a free slot and no recent attempt", () => {
    expect(autoRestoreDecision(base, now)).toEqual({ act: true });
    expect(autoRestoreDecision({ ...base, lastAutoRestoreAt: ago(AUTO_RESTORE_EVERY_MS) }, now)).toEqual({ act: true });
  });
  it("off", () => expect(autoRestoreDecision({ ...base, autoRestore: false }, now)).toEqual({ act: false, reason: "off" }));
  it("not paused (active, restoring, coming up)", () => {
    for (const status of ["ACTIVE_HEALTHY", "RESTORING", "COMING_UP", "PAUSING"]) expect(autoRestoreDecision({ ...base, status }, now)).toEqual({ act: false, reason: "not-paused" });
  });
  it("at most one attempt per 6 hours", () => {
    expect(AUTO_RESTORE_EVERY_MS).toBe(6 * 3600_000);
    expect(autoRestoreDecision({ ...base, lastAutoRestoreAt: ago(AUTO_RESTORE_EVERY_MS - 1) }, now)).toEqual({ act: false, reason: "too-soon" });
  });
  it("never without a free slot (it never pauses another project to make one)", () => {
    expect(autoRestoreDecision({ ...base, slotsLeft: 0 }, now)).toEqual({ act: false, reason: "no-slot" });
  });
  it("stops once the token was denied write access", () => {
    expect(autoRestoreDecision({ ...base, accessDenied: true }, now)).toEqual({ act: false, reason: "denied" });
    expect(autoRestoreDecision({ ...base, accessDenied: true, slotsLeft: 0 }, now)).toEqual({ act: false, reason: "denied" });
  });
});
