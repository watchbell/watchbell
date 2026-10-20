import { describe, expect, it } from "vitest";
import type { Health } from "@/lib/data/metrics-db";
import { healthRows } from "./health";

const series = { uptime: [], p95: [], s5xx: [0, 0], deploys: [1] };
const h = (over: Partial<Health>): Health => ({ uptime: 99.5, p95: 412.4, s5xx: 3, deploys: 2, series, ...over });
const values = (x: Health) => healthRows(x).map((r) => [r.label, r.value, r.unit]);

describe("healthRows", () => {
  it("shows the figures with their units", () => {
    expect(values(h({}))).toEqual([
      ["Avg uptime", "99.50%", ""], ["p95 response", "412", "ms"], ["5xx responses", "3", "/24h"], ["Deployments", "2", "/24h"],
    ]);
  });

  it("floors uptime like pct() everywhere else (final review M7)", () => {
    expect(healthRows(h({ uptime: 99.996 }))[0].value).toBe("99.99%");
  });

  it("shows — for uptime, p95 and 5xx before any check exists, without units (task 12 M3)", () => {
    expect(values(h({ uptime: null, p95: null, s5xx: 0, deploys: 0 }))).toEqual([
      ["Avg uptime", "—", ""], ["p95 response", "—", ""], ["5xx responses", "—", ""], ["Deployments", "0", "/24h"],
    ]);
  });

  it("a real 0 5xx with checks is still 0", () => {
    expect(healthRows(h({ s5xx: 0 }))[2].value).toBe("0");
  });
});
