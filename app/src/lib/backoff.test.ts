import { describe, expect, it } from "vitest";
import { BACKOFF, backoffDelayS, backoffWaitS, failureAlertDue } from "./backoff";

// Watchbell 1.2.1 (audit L5/L6): exponential back-off instead of hard fixed windows.
describe("back-off", () => {
  it("lets the first failures through, then doubles the wait from 30 s up to an hour", () => {
    expect([0, 1, BACKOFF.free - 1].map((n) => backoffDelayS(n))).toEqual([0, 0, 0]);
    expect(backoffDelayS(BACKOFF.free)).toBe(30);
    expect(backoffDelayS(BACKOFF.free + 1)).toBe(60);
    expect(backoffDelayS(BACKOFF.free + 3)).toBe(240);
    expect(backoffDelayS(BACKOFF.free + 20)).toBe(3600);
  });

  it("waits from the last failure; nothing to wait once the delay has passed", () => {
    const last = new Date("2026-10-24T10:00:00Z");
    expect(backoffWaitS(BACKOFF.free - 1, last, new Date("2026-10-24T10:00:01Z"))).toBe(0);
    expect(backoffWaitS(BACKOFF.free + 1, last, new Date("2026-10-24T10:00:15Z"))).toBe(45);
    expect(backoffWaitS(BACKOFF.free + 1, last, new Date("2026-10-24T10:01:00Z"))).toBe(0);
    expect(backoffWaitS(BACKOFF.free + 1, null, new Date())).toBe(0);
  });

  it("alerts at the 10th failure of the day (the hourly cap is the caller's)", () => {
    expect(failureAlertDue(9)).toBe(false);
    expect(failureAlertDue(10)).toBe(true);
    expect(failureAlertDue(11)).toBe(true);
  });
});
