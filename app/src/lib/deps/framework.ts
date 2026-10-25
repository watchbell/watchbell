import type { DepSeverity } from "@/db/schema";
import { vulnerabilities, worstSeverity } from "@/lib/security/rules";
import { compareVersions } from "@/lib/security/semver";
import type { Finding, Severity } from "@/lib/security/types";
import { sameMajor } from "./auto-policy";
import { isVersion } from "./lockfile";
import type { Upgrade } from "./plan";

// Watchbell 1.2 (owner 23 Oct): the Security card's Next.js check (ops.app_security: the version the live site runs and
// its OSV.dev advisories) gets an alert (FrameworkVulnerable) and an update PR proposal. Pure. Which version the PR moves
// to, and the upgrades it carries: `next`, and `eslint-config-next` at the same version (it is released with every
// Next.js version; the PR only changes it when package.json lists it).

export const FRAMEWORK_PACKAGES = ["next", "eslint-config-next"] as const;

const LOWER: Record<Severity, DepSeverity> = { CRITICAL: "critical", HIGH: "high", MODERATE: "moderate", LOW: "low", UNKNOWN: "unknown" };

// The smallest version that clears the advisories within the running major: the highest of the per-advisory fixes in
// that major (16.3.8 with fixes 16.3.9 and 16.4.1 → 16.4.1). When no fix is in the same major, the version that clears
// them all (a major update, which only an approval can open). Null: no usable fix, or the version can't be read.
// Watchbell doesn't ask the npm registry for a newer patch: no code here reads it today, so the advisory's version is used.
export function frameworkTarget(version: string | null, findings: Finding[]): string | null {
  if (!version || !isVersion(version)) return null;
  const fixes = findings.map((f) => f.fixed).filter((x): x is string => !!x && isVersion(x) && compareVersions(x, version) > 0);
  if (!fixes.length) return null;
  const same = fixes.filter((x) => sameMajor(version, x));
  const pool = same.length ? same : fixes;
  return pool.reduce((best, x) => (compareVersions(x, best) > 0 ? x : best));
}

export type FrameworkPlan = { from: string; to: string; upgrades: Upgrade[]; installed: Map<string, string> };

// The update PR's upgrades for an app whose check says "vulnerable", or null when there is nothing to update.
export function frameworkPlan(row: { version: string | null; status: string; findings: Finding[] } | null): FrameworkPlan | null {
  if (!row || row.status !== "vulnerable" || !row.findings.length || !row.version) return null;
  const to = frameworkTarget(row.version, row.findings);
  if (!to) return null;
  const severity = LOWER[worstSeverity(row.findings)];
  const ids = [...new Set(row.findings.map((f) => f.id))];
  const cves = [...new Set(row.findings.flatMap((f) => (f.cve ? [f.cve] : [])))];
  const upgrades: Upgrade[] = [
    { package: "next", to, vulnIds: ids, cves, severity },
    { package: "eslint-config-next", to, vulnIds: [], cves: [], severity, companionOf: "next" },
  ];
  return { from: row.version, to, upgrades, installed: new Map(FRAMEWORK_PACKAGES.map((p) => [p, row.version!])) };
}

// The alert's message: "Next.js 16.3.8 has 2 known vulnerabilities (critical), fixed in 16.4.1." The version is the
// one the update PR moves to (frameworkTarget, same major), so the alert and the proposal agree (review T1). Advisories
// only fixed in a higher major add "(one fix needs Next.js 16)" / "(some fixes need Next.js 17)".
export function frameworkMessage(version: string | null, findings: Finding[]): string {
  const fix = frameworkTarget(version, findings);
  const later = fix ? findings.map((f) => f.fixed).filter((x): x is string => !!x && isVersion(x) && compareVersions(x, fix) > 0) : [];
  const top = later.reduce<string | null>((best, x) => (best === null || compareVersions(x, best) > 0 ? x : best), null);
  const note = top ? ` (${later.length === 1 ? "one fix needs" : "some fixes need"} Next.js ${top.split(".")[0]})` : "";
  return `Next.js ${version ?? "(unknown version)"} has ${vulnerabilities(findings.length)} (${worstSeverity(findings).toLowerCase()}), ${fix ? `fixed in ${fix}${note}` : "no fix yet"}.`;
}

// Review T1 minor 8: eslint-config-next is released with every Next.js version, so an update PR that moves next (the
// dependency scan's, too) moves it to the same version when package.json lists it (planBumps skips it otherwise). Not
// when it has an upgrade of its own.
export function withCompanions(upgrades: Upgrade[]): Upgrade[] {
  const next = upgrades.find((u) => u.package === "next" && !u.companionOf);
  if (!next || upgrades.some((u) => u.package === "eslint-config-next")) return upgrades;
  return [...upgrades, { package: "eslint-config-next", to: next.to, vulnIds: [], cves: [], severity: next.severity, companionOf: "next" }];
}
