import { describe, expect, it } from "vitest";
import { IDLE_AFTER_MS, isIdle, REFRESH_MS, liveText, refreshDue, refreshOnReturn, refreshPeriod, retryDelay } from "./refresh";

const base = { visible: true, held: false, online: true, pending: false, lastAt: 0, requestedAt: 0, lastInputAt: 0, now: 60_000 };

describe("refreshDue (R1)", () => {
  it("polls faster when a page asks for it (AI › Ask while a question waits), still holding, hidden and idle-aware", () => {
    const fast = { ...base, period: 15_000, now: 15_000 };
    expect(refreshDue(fast)).toBe(true);
    expect(refreshDue({ ...fast, now: 14_999 })).toBe(false);
    expect(refreshDue({ ...fast, held: true })).toBe(false);
    expect(refreshDue({ ...fast, visible: false })).toBe(false);
    expect(refreshDue({ ...fast, lastInputAt: -IDLE_AFTER_MS, now: 15_000 })).toBe(false); // idle: back to every 4 min
  });
  it("refreshes every 60 s (owner, 13 Oct: the collector only changes data once a minute)", () => {
    expect(REFRESH_MS).toBe(60_000);
    expect(refreshDue(base)).toBe(true);
    expect(refreshDue({ ...base, now: 59_999 })).toBe(false);
  });
  it("waits while the tab is hidden", () => {
    expect(refreshDue({ ...base, visible: false })).toBe(false);
  });
  it("waits while a dialog or menu is open", () => {
    expect(refreshDue({ ...base, held: true, now: 600_000 })).toBe(false);
  });
  it("doesn't ask again while the last refresh hasn't landed, unless it is stuck for a whole period", () => {
    expect(refreshDue({ ...base, requestedAt: 10_000, now: 60_000 })).toBe(false);
    expect(refreshDue({ ...base, requestedAt: 10_000, now: 70_000 })).toBe(true);
  });
  it("skips refreshes while the browser is offline (final review I2)", () => {
    expect(refreshDue({ ...base, online: false, now: 600_000 })).toBe(false);
  });
  it("never replaces a refresh that is still in flight, so a slow page still lands (J3)", () => {
    const inFlight = { ...base, pending: true, requestedAt: 60_000 };
    expect(refreshDue({ ...inFlight, now: 90_000 })).toBe(false);
    expect(refreshDue({ ...inFlight, now: 119_999 })).toBe(false);
    expect(refreshDue({ ...inFlight, now: 120_000 })).toBe(true); // outstanding for a minute: taken as lost
  });
});

describe("idle backoff (final review I4)", () => {
  it("polls four times slower (every 4 min) after 30 minutes without input, and every 60 s again after input", () => {
    expect(isIdle(0, IDLE_AFTER_MS - 1)).toBe(false);
    expect(isIdle(0, IDLE_AFTER_MS)).toBe(true);
    expect(refreshPeriod(0, IDLE_AFTER_MS)).toBe(240_000);
    expect(refreshPeriod(0, 0)).toBe(60_000);
    const idle = { ...base, lastInputAt: 0, lastAt: IDLE_AFTER_MS, requestedAt: IDLE_AFTER_MS };
    expect(refreshDue({ ...idle, now: IDLE_AFTER_MS + 60_000 })).toBe(false);
    expect(refreshDue({ ...idle, now: IDLE_AFTER_MS + 240_000 })).toBe(true);
    expect(refreshDue({ ...idle, lastInputAt: IDLE_AFTER_MS + 10_000, now: IDLE_AFTER_MS + 60_000 })).toBe(true);
  });
});

describe("refreshOnReturn", () => {
  const r = { visible: true, held: false, online: true, pending: false, lastAt: 10, requestedAt: 5 };
  it("refreshes at once on coming back to the tab or back online", () => {
    expect(refreshOnReturn(r)).toBe(true);
  });
  it("not while hidden, held, offline, or with a refresh on its way", () => {
    expect(refreshOnReturn({ ...r, visible: false })).toBe(false);
    expect(refreshOnReturn({ ...r, held: true })).toBe(false);
    expect(refreshOnReturn({ ...r, online: false })).toBe(false);
    expect(refreshOnReturn({ ...r, pending: true })).toBe(false);
    expect(refreshOnReturn({ ...r, requestedAt: 20 })).toBe(false);
  });
});

describe("liveText", () => {
  it("counts whole seconds since the data arrived, never below zero", () => {
    expect(liveText(1_000, 4_500)).toBe("Updated 3s ago · every 60s");
    expect(liveText(5_000, 4_000)).toBe("Updated 0s ago · every 60s");
  });
  it("says when the tab polls slower because nobody is using it", () => {
    expect(liveText(1_000, 4_500, true)).toBe("Updated 3s ago · every 4 min (idle)");
  });
});

describe("retryDelay", () => {
  it("backs off from 15 s to a 30 s cap", () => {
    expect([0, 1, 2, 3, 10].map(retryDelay)).toEqual([15_000, 22_500, 30_000, 30_000, 30_000]);
  });
});
