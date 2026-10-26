import { describe, expect, it } from "vitest";
import type { Health } from "@/lib/data/metrics-db";
import { healthRows } from "./health";

const series = { uptime: [], p95: [], s5xx: [0, 0], deploys: [1] };
const h = (over: Partial<Health>): Health => ({ uptime: 99.5, p95: 412.4, s5xx: 3, deploys: 2, series, ...over });
const values = (x: Health) => healthRows(x).map((r) => [r.label, r.value, r.unit]);

describe("healthRows", () => {
  it("shows the figures with their units", () => {
    expect(values(h({}))).toEqual([
      ["Sites reachable", "99.50%", ""], ["Response time", "412", "ms"], ["Server errors", "3", "in 24 h"], ["New versions", "2", "in 24 h"],
    ]);
  });

  it("floors uptime like pct() everywhere else (final review M7)", () => {
    expect(healthRows(h({ uptime: 99.996 }))[0].value).toBe("99.99%");
  });

  it("shows — for uptime, p95 and 5xx before any check exists, without units (task 12 M3)", () => {
    expect(values(h({ uptime: null, p95: null, s5xx: 0, deploys: 0 }))).toEqual([
      ["Sites reachable", "—", ""], ["Response time", "—", ""], ["Server errors", "—", ""], ["New versions", "0", "in 24 h"],
    ]);
  });

  it("a real 0 5xx with checks is still 0", () => {
    expect(healthRows(h({ s5xx: 0 }))[2].value).toBe("0");
  });

  it("explains each figure in plain words and keeps the technical name for the tooltip (D22)", () => {
    expect(healthRows(h({})).map((r) => [r.label, r.hint, r.term])).toEqual([
      ["Sites reachable", "Share of checks that got an answer, last 24 h", "Uptime: average of every monitor's successful checks"],
      ["Response time", "Most checks (95 of 100) answered faster than this", "p95 response time"],
      ["Server errors", "Pages that broke on the server side", "HTTP 5xx responses"],
      ["New versions", "Deploys put live in the last 24 h", "Production deployments"],
    ]);
  });

  it("badges say who produced the figure, not 'Own check' / 'API' (D22)", () => {
    expect(healthRows(h({})).map((r) => r.srcText)).toEqual(["Checked by Watchbell", "Checked by Watchbell", "Checked by Watchbell", "From Vercel"]);
  });
});
