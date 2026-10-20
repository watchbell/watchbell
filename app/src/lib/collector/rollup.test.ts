import { describe, expect, it } from "vitest";
import { hourStart, percentile, rollup, rollupSince } from "./rollup";

describe("rollup", () => {
  it("counts failures and 5xx and takes nearest-rank percentiles of the latencies", () => {
    const rows = [
      ...Array.from({ length: 18 }, (_, i) => ({ ok: true, statusCode: 200, latencyMs: 100 + i })),
      { ok: false, statusCode: 503, latencyMs: 900 },
      { ok: false, statusCode: null, latencyMs: null },
    ];
    // 19 latencies (100…117 and 900): nearest rank p50 = 10th value = 109, p95 = 19th = 900.
    expect(rollup(rows)).toEqual({ checks: 20, failures: 2, p50Ms: 109, p95Ms: 900, maxMs: 900, status5xx: 1, maintenance: 0 });
  });
  it("handles an empty hour", () => {
    expect(rollup([])).toEqual({ checks: 0, failures: 0, p50Ms: null, p95Ms: null, maxMs: null, status5xx: 0, maintenance: 0 });
    expect(percentile([], 0.5)).toBeNull();
  });
  it("counts checks inside a maintenance window apart, out of checks, failures, the percentiles and 5xx (U5)", () => {
    const rows = [
      { ok: true, statusCode: 200, latencyMs: 100, inMaintenance: false },
      { ok: true, statusCode: 200, latencyMs: 120, inMaintenance: false },
      { ok: false, statusCode: 503, latencyMs: 5000, inMaintenance: true },
      { ok: false, statusCode: null, latencyMs: null, inMaintenance: true },
    ];
    expect(rollup(rows)).toEqual({ checks: 2, failures: 0, p50Ms: 100, p95Ms: 120, maxMs: 120, status5xx: 0, maintenance: 2 });
    expect(rollup(rows.slice(2))).toEqual({ checks: 0, failures: 0, p50Ms: null, p95Ms: null, maxMs: null, status5xx: 0, maintenance: 2 });
  });
  it("floors to the hour", () => {
    expect(hourStart(new Date("2026-10-12T10:59:59.900Z")).toISOString()).toBe("2026-10-12T10:00:00.000Z");
  });
});

describe("rollupSince", () => {
  const now = new Date("2026-10-12T20:00:00Z"); // 03:00 WIB, when the daily job runs
  const H = 3_600_000;
  it("starts an hour before the latest rolled-up hour, redoing the last ones as a margin", () => {
    expect(rollupSince(new Date("2026-10-11T19:00:00Z"), now)).toEqual(new Date("2026-10-11T18:00:00Z"));
  });
  it("goes back at most 7 days, the raw checks retention", () => {
    expect(rollupSince(new Date("2026-09-01T00:00:00Z"), now)).toEqual(new Date(now.getTime() - 7 * 24 * H));
    expect(rollupSince(null, now)).toEqual(new Date(now.getTime() - 7 * 24 * H));
  });
});
