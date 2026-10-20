import { compareVersions } from "@/lib/security/semver";
import type { DepSeverity } from "@/db/schema";
import type { Dep } from "./lockfile";

// Stage 9 slice 5: OSV.dev for a whole lockfile. Free, no key, read-only (POST is only the query's shape). Pure here: the
// batch requests, reading the answers, and an advisory's severity, CVE aliases and fix for one installed version. The
// network calls are in lib/deps/osv-client.ts.

export const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";
export const OSV_VULN_URL = "https://api.osv.dev/v1/vulns/";
export const BATCH_MAX = 1000; // OSV's limit per querybatch
export const SUMMARY_MAX = 200;
export const ALIASES_MAX = 20;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export const isVulnId = (v: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$/.test(v);

export function batchBodies(deps: Dep[]): { queries: { package: { name: string; ecosystem: "npm" }; version: string }[] }[] {
  const out = [];
  for (let i = 0; i < deps.length; i += BATCH_MAX) {
    out.push({ queries: deps.slice(i, i + BATCH_MAX).map((d) => ({ package: { name: d.name, ecosystem: "npm" as const }, version: d.version })) });
  }
  return out;
}

// One querybatch answer → the advisory ids per query (same order), or null when it isn't one. A result with a
// next_page_token (more than 1,000 advisories for one version) keeps the ids it has.
export function parseBatch(body: unknown, expected: number): string[][] | null {
  if (!isObj(body) || !Array.isArray(body.results) || body.results.length !== expected) return null;
  return body.results.map((r) => (isObj(r) ? arr(r.vulns).map((v) => (isObj(v) ? str(v.id) : null)).filter((x): x is string => !!x && isVulnId(x)) : []));
}

// ---- one advisory ----
export type Advisory = {
  id: string; aliases: string[]; summary: string; severity: DepSeverity; withdrawn: boolean; affected: unknown;
};

const DB_SEVERITY: Record<string, DepSeverity> = { CRITICAL: "critical", HIGH: "high", MODERATE: "moderate", MEDIUM: "moderate", LOW: "low" };

// CVSS v3.x base score from its vector (the spec's formula), for advisories without a GitHub severity label.
export function cvss3Score(vector: string): number | null {
  const m = /^CVSS:3\.[01]\/(.+)$/.exec(vector.trim());
  if (!m) return null;
  const v: Record<string, string> = {};
  for (const part of m[1].split("/")) {
    const [k, val] = part.split(":");
    if (k && val) v[k] = val;
  }
  const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
  const AC: Record<string, number> = { L: 0.77, H: 0.44 };
  const UI: Record<string, number> = { N: 0.85, R: 0.62 };
  const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };
  const changed = v.S === "C";
  const PR: Record<string, number> = changed ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 };
  if (![AV[v.AV], AC[v.AC], PR[v.PR], UI[v.UI], CIA[v.C], CIA[v.I], CIA[v.A]].every((x) => typeof x === "number") || (v.S !== "U" && v.S !== "C")) return null;
  const iss = 1 - (1 - CIA[v.C]) * (1 - CIA[v.I]) * (1 - CIA[v.A]);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  const exploit = 8.22 * AV[v.AV] * AC[v.AC] * PR[v.PR] * UI[v.UI];
  if (impact <= 0) return 0;
  const roundUp = (x: number) => {
    const i = Math.round(x * 100_000);
    return i % 10_000 === 0 ? i / 100_000 : (Math.floor(i / 10_000) + 1) / 10;
  };
  return roundUp(Math.min(changed ? 1.08 * (impact + exploit) : impact + exploit, 10));
}

export const scoreSeverity = (s: number): DepSeverity => (s >= 9 ? "critical" : s >= 7 ? "high" : s >= 4 ? "moderate" : s > 0 ? "low" : "unknown");

// GitHub's label (database_specific.severity) first, then a CVSS v3 vector; a malicious-package report (MAL-) is
// critical; anything else is unknown.
export function severityOf(v: Obj): DepSeverity {
  const label = isObj(v.database_specific) ? str(v.database_specific.severity)?.toUpperCase() : null;
  if (label && DB_SEVERITY[label]) return DB_SEVERITY[label];
  for (const s of arr(v.severity)) {
    if (!isObj(s) || (s.type !== "CVSS_V3" && s.type !== "CVSS_V31")) continue;
    const score = str(s.score) ? cvss3Score(str(s.score)!) : null;
    if (score !== null) return scoreSeverity(score);
  }
  const id = str(v.id) ?? "";
  return id.startsWith("MAL-") ? "critical" : "unknown";
}

const clean = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

export function parseAdvisory(body: unknown): Advisory | null {
  if (!isObj(body)) return null;
  const id = str(body.id);
  if (!id || !isVulnId(id)) return null;
  const aliases = [...new Set(arr(body.aliases).map(str).filter((a): a is string => !!a && isVulnId(a)))].slice(0, ALIASES_MAX);
  const summary = clean(str(body.summary) ?? str(body.details)?.split(/\n/)[0] ?? "", SUMMARY_MAX);
  return { id, aliases, summary, severity: severityOf(body), withdrawn: !!str(body.withdrawn), affected: body.affected };
}

const isPkg = (a: Obj, name: string) => isObj(a.package) && a.package.name === name && a.package.ecosystem === "npm";

// The lowest `fixed` among the package's ranges whose [introduced, fixed) holds the version; null when no range that
// holds it names a fix (last_affected, or still open).
export function fixedFor(affected: unknown, name: string, version: string): string | null {
  let best: string | null = null;
  for (const a of arr(affected)) {
    if (!isObj(a) || !isPkg(a, name)) continue;
    for (const r of arr(a.ranges)) {
      if (!isObj(r) || (r.type !== "SEMVER" && r.type !== "ECOSYSTEM")) continue;
      let start: string | null = null;
      for (const e of arr(r.events)) {
        if (!isObj(e)) continue;
        const introduced = str(e.introduced);
        const fixed = str(e.fixed);
        if (introduced) start = introduced;
        else if (fixed && start !== null) {
          const holds = compareVersions(version, start) >= 0 && compareVersions(version, fixed) < 0;
          if (holds && (best === null || compareVersions(fixed, best) < 0)) best = fixed;
          start = null;
        } else if (str(e.last_affected) || str(e.limit)) start = null;
      }
    }
  }
  return best;
}

// What the scan stores for one vulnerable package version and advisory.
export type FoundVuln = {
  package: string; installedVersion: string; vulnId: string; aliases: string[]; severity: DepSeverity; fixedVersion: string | null;
  summary: string; dev: boolean; source: "osv" | "dependabot";
};

// The scan's findings: each dependency's advisory ids joined with the advisories read, or with `known` (stored rows
// whose details weren't read again; keyed "name@version|id", plan.ts vulnKey). Withdrawn advisories and ids whose
// details are missing are skipped.
export function findings(deps: Dep[], ids: string[][], advisories: ReadonlyMap<string, Advisory>, known: ReadonlyMap<string, FoundVuln> = new Map()): FoundVuln[] {
  const out: FoundVuln[] = [];
  deps.forEach((d, i) => {
    for (const id of ids[i] ?? []) {
      const k = known.get(`${d.name}@${d.version}|${id}`);
      if (k) {
        out.push({ ...k, dev: d.dev });
        continue;
      }
      const a = advisories.get(id);
      if (!a || a.withdrawn) continue;
      out.push({
        package: d.name, installedVersion: d.version, vulnId: a.id, aliases: a.aliases, severity: a.severity,
        fixedVersion: fixedFor(a.affected, d.name, d.version), summary: a.summary, dev: d.dev, source: "osv",
      });
    }
  });
  return out;
}

export const cveOf = (aliases: string[]): string | null => aliases.find((a) => /^CVE-\d{4}-\d+$/.test(a)) ?? null;
