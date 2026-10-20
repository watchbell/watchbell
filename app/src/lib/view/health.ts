import type { Health } from "@/lib/data/metrics-db";
import { pct } from "./format";

export type HealthRow = { label: string; src: "own" | "api"; value: string; unit: string; series: (number | null)[] };

// Overview → Health rows (mockup section 1). With no checks in the window, every figure that comes from our own
// checks reads "—" rather than a number: 0 5xx would claim "no errors" when nothing was checked (task 12 M3). Uptime is
// floored by pct() like every other uptime in the console (final review M7: 99.996 is "99.99%", never "100.00").
// A "—" carries no unit.
export function healthRows(h: Health): HealthRow[] {
  const checked = h.uptime !== null;
  const row = (label: string, src: "own" | "api", value: string, unit: string, series: (number | null)[]): HealthRow =>
    ({ label, src, value, unit: value === "—" ? "" : unit, series });
  return [
    row("Avg uptime", "own", pct(h.uptime), "", h.series.uptime),
    row("p95 response", "own", h.p95 === null ? "—" : String(Math.round(h.p95)), "ms", h.series.p95),
    row("5xx responses", "own", checked ? String(h.s5xx) : "—", "/24h", h.series.s5xx),
    row("Deployments", "api", String(h.deploys), "/24h", h.series.deploys),
  ];
}
