import type { Health } from "@/lib/data/metrics-db";
import { pct } from "./format";

// `hint` is the plain-words line under the label; `term` is the technical name, kept for a tooltip and screen readers;
// `srcText` is the badge wording shown when the data-source tags are on.
export type HealthRow = {
  label: string; hint: string; term: string; src: "own" | "api"; srcText: string;
  value: string; unit: string; series: (number | null)[];
};

const OWN = "Checked by Watchbell";
const VERCEL = "From Vercel";

// Overview → Health rows (mockup section 1). With no checks in the window, every figure that comes from our own
// checks reads "—" rather than a number: 0 5xx would claim "no errors" when nothing was checked (task 12 M3). Uptime is
// floored by pct() like every other uptime in the console (final review M7: 99.996 is "99.99%", never "100.00").
// A "—" carries no unit. The window is the last 24 hours, not the calendar day, so counts read "in 24 h".
export function healthRows(h: Health): HealthRow[] {
  const checked = h.uptime !== null;
  const row = (r: Omit<HealthRow, "unit"> & { unit: string }): HealthRow => ({ ...r, unit: r.value === "—" ? "" : r.unit });
  return [
    row({
      label: "Sites reachable", hint: "Share of checks that got an answer, last 24 h", term: "Uptime: average of every monitor's successful checks",
      src: "own", srcText: OWN, value: pct(h.uptime), unit: "", series: h.series.uptime,
    }),
    row({
      label: "Response time", hint: "Most checks (95 of 100) answered faster than this", term: "p95 response time",
      src: "own", srcText: OWN, value: h.p95 === null ? "—" : String(Math.round(h.p95)), unit: "ms", series: h.series.p95,
    }),
    row({
      label: "Server errors", hint: "Pages that broke on the server side", term: "HTTP 5xx responses",
      src: "own", srcText: OWN, value: checked ? String(h.s5xx) : "—", unit: "in 24 h", series: h.series.s5xx,
    }),
    row({
      label: "New versions", hint: "Deploys put live in the last 24 h", term: "Production deployments",
      src: "api", srcText: VERCEL, value: String(h.deploys), unit: "in 24 h", series: h.series.deploys,
    }),
  ];
}
