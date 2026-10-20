import type { DepSeverity } from "@/db/schema";
import { compareVersions } from "@/lib/security/semver";
import { type Dep, isPackageName } from "./lockfile";
import { ALIASES_MAX, type FoundVuln, isVulnId, SUMMARY_MAX } from "./osv";

// Stage 9 slice 5: the scan's pure decisions. When a repository is scanned again, how a scan's findings become row
// changes, how Dependabot alerts add to OSV's findings, and what an app's open vulnerabilities mean for its alert.

export const RESCAN_MS = 7 * 86_400_000; // an unchanged lockfile is queried again after a week (new advisories)
export const RETRY_MS = 20 * 3_600_000; // a failed scan is retried by the next daily run
export const SEVERITY_ORDER: DepSeverity[] = ["critical", "high", "moderate", "low", "unknown"];
export const rank = (s: DepSeverity): number => SEVERITY_ORDER.indexOf(s);

export type ScanRow = { lockfileSha: string | null; scannedAt: Date | null; queriedAt: Date | null; error: string | null };

// Whether to read and query the lockfile now. Never scanned, a new lockfile SHA, a failed last scan, or a week since
// the last OSV query: yes. Otherwise the cached result stands (the lockfile isn't downloaded or queried again).
export function scanDue(row: ScanRow | null, sha: string | null, now: Date, force = false): boolean {
  if (force || !row || !row.scannedAt) return true;
  if (row.error) return now.getTime() - row.scannedAt.getTime() >= RETRY_MS || row.lockfileSha !== sha;
  if (row.lockfileSha !== sha) return true;
  return !row.queriedAt || now.getTime() - row.queriedAt.getTime() >= RESCAN_MS;
}

// Never scanned first, then the oldest scan: a run that runs out of time continues where it stopped the next day.
export function scanOrder<R extends { id: string; scannedAt: Date | null }>(repos: R[]): R[] {
  return [...repos].sort((a, b) => (a.scannedAt?.getTime() ?? -1) - (b.scannedAt?.getTime() ?? -1) || (a.id < b.id ? -1 : 1));
}

// ---- Dependabot (optional: only with "Dependabot alerts: Read" on the token) ----
export type DependabotAlert = {
  package: string; ghsaId: string; cveId: string | null; summary: string; severity: DepSeverity; range: string | null; fixed: string | null; dev: boolean;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const SEV: Record<string, DepSeverity> = { critical: "critical", high: "high", medium: "moderate", moderate: "moderate", low: "low" };

export function parseDependabot(body: unknown): DependabotAlert[] | null {
  if (!Array.isArray(body)) return null;
  const out: DependabotAlert[] = [];
  for (const a of body) {
    if (!isObj(a) || a.state !== "open" || !isObj(a.dependency) || !isObj(a.security_advisory)) continue;
    const pkg = isObj(a.dependency.package) && a.dependency.package.ecosystem === "npm" ? str(a.dependency.package.name) : null;
    const ghsa = str(a.security_advisory.ghsa_id);
    if (!pkg || !isPackageName(pkg) || !ghsa || !isVulnId(ghsa)) continue;
    const v = isObj(a.security_vulnerability) ? a.security_vulnerability : {};
    const fixed = isObj(v.first_patched_version) ? str(v.first_patched_version.identifier) : null;
    const cve = str(a.security_advisory.cve_id);
    out.push({
      package: pkg, ghsaId: ghsa, cveId: cve && /^CVE-\d{4}-\d+$/.test(cve) ? cve : null,
      summary: (str(a.security_advisory.summary) ?? "").replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX),
      severity: SEV[(str(v.severity) ?? str(a.security_advisory.severity) ?? "").toLowerCase()] ?? "unknown",
      range: str(v.vulnerable_version_range), fixed: fixed && fixed.length <= 100 ? fixed : null, dev: a.dependency.scope === "development",
    });
  }
  return out;
}

// GitHub's range form: ">= 13.0.0, < 13.5.4", "<= 1.2.3", "= 2.0.0". Unreadable → false.
export function inRange(version: string, range: string): boolean {
  const parts = range.split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  return parts.every((p) => {
    const m = /^(<=|>=|<|>|=)\s*v?(\S+)$/.exec(p);
    if (!m) return false;
    const c = compareVersions(version, m[2]);
    return m[1] === "<" ? c < 0 : m[1] === "<=" ? c <= 0 : m[1] === ">" ? c > 0 : m[1] === ">=" ? c >= 0 : c === 0;
  });
}

// Dependabot alerts OSV didn't already report (same package and the GHSA id or its CVE), at the installed versions their
// range holds. A package not in the lockfile's list (or whose range can't be read) is skipped: no row without a version.
export function mergeDependabot(found: FoundVuln[], alerts: DependabotAlert[], deps: Dep[]): FoundVuln[] {
  const out = [...found];
  for (const a of alerts) {
    const known = out.some((f) => f.package === a.package && (f.vulnId === a.ghsaId || f.aliases.includes(a.ghsaId) || (a.cveId !== null && f.aliases.includes(a.cveId))));
    if (known || !a.range) continue;
    for (const d of deps) {
      if (d.name !== a.package || !inRange(d.version, a.range)) continue;
      out.push({
        package: a.package, installedVersion: d.version, vulnId: a.ghsaId, aliases: a.cveId ? [a.cveId] : [], severity: a.severity,
        fixedVersion: a.fixed, summary: a.summary, dev: a.dev || d.dev, source: "dependabot",
      });
    }
  }
  return out;
}

// ---- found → row changes ----
export type OpenVuln = {
  id: string; package: string; installedVersion: string; vulnId: string; severity: DepSeverity; fixedVersion: string | null; summary: string;
  aliases: string[]; dev: boolean; direct: boolean;
};
export const vulnKey = (v: { package: string; installedVersion: string; vulnId: string }): string => `${v.package}@${v.installedVersion}|${v.vulnId}`;

export type VulnPlan = {
  insert: (FoundVuln & { direct: boolean })[];
  update: { id: string; severity: DepSeverity; fixedVersion: string | null; summary: string; aliases: string[]; dev: boolean; direct: boolean }[];
  resolve: string[];
};

export function planVulns(open: OpenVuln[], found: FoundVuln[], direct: ReadonlySet<string>): VulnPlan {
  const byKey = new Map(open.map((o) => [vulnKey(o), o]));
  const seen = new Set<string>();
  const plan: VulnPlan = { insert: [], update: [], resolve: [] };
  for (const f of found) {
    const k = vulnKey(f);
    if (seen.has(k)) continue;
    seen.add(k);
    const row = { ...f, aliases: f.aliases.slice(0, ALIASES_MAX), summary: f.summary.slice(0, SUMMARY_MAX), direct: direct.has(f.package) };
    const had = byKey.get(k);
    if (had) plan.update.push({ id: had.id, severity: row.severity, fixedVersion: row.fixedVersion, summary: row.summary, aliases: row.aliases, dev: row.dev, direct: row.direct });
    else plan.insert.push(row);
  }
  plan.resolve = open.filter((o) => !seen.has(vulnKey(o))).map((o) => o.id);
  return plan;
}

// Stored OSV rows that a scan may reuse instead of reading the advisory again (keeps a re-scan fast inside the daily
// budget): same package, version and advisory, and a fix already known. Rows without a fix are read again, so a fix
// published later shows up; a forced scan (Scan now) reads everything.
export function knownFindings(open: (OpenVuln & { source?: "osv" | "dependabot" })[], force: boolean): Map<string, FoundVuln> {
  const out = new Map<string, FoundVuln>();
  if (force) return out;
  for (const o of open) {
    if (!o.fixedVersion || o.source === "dependabot") continue;
    out.set(vulnKey(o), {
      package: o.package, installedVersion: o.installedVersion, vulnId: o.vulnId, aliases: o.aliases, severity: o.severity, fixedVersion: o.fixedVersion,
      summary: o.summary, dev: o.dev, source: "osv",
    });
  }
  return out;
}

// The advisory ids whose details must be read: those with at least one dependency not covered by `known`.
export function idsToRead(deps: Dep[], ids: string[][], known: ReadonlyMap<string, FoundVuln>): string[] {
  const need = new Set<string>();
  deps.forEach((d, i) => {
    for (const id of ids[i] ?? []) if (!known.has(`${d.name}@${d.version}|${id}`)) need.add(id);
  });
  return [...need];
}

// ---- an app's alert ----
export type Counts = Record<DepSeverity, number>;
export function countBySeverity(vulns: { severity: DepSeverity }[]): Counts {
  const c: Counts = { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 };
  for (const v of vulns) c[v.severity]++;
  return c;
}

export const isRce = (summary: string): boolean => /\bRCE\b|remote code execution/i.test(summary);

// critical: a critical advisory, or one whose summary reads as remote code execution; warning: a high one; else none.
// Development-only packages (npm's lockfile marks them) don't ring: they never reach production.
export function alertLevel(vulns: { severity: DepSeverity; summary: string; dev: boolean }[]): "critical" | "warning" | null {
  const live = vulns.filter((v) => !v.dev);
  if (live.some((v) => v.severity === "critical" || isRce(v.summary))) return "critical";
  return live.some((v) => v.severity === "high") ? "warning" : null;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// "2 vulnerable packages (1 critical, 1 high): next 15.0.0 → 15.0.5, lodash 4.17.20 → 4.17.21." The ringing ones
// (not dev, high or worse) first, worst first; at most 4 named; ≤ 300 characters.
export function alertMessage(vulns: { package: string; installedVersion: string; fixedVersion: string | null; severity: DepSeverity; summary: string; dev: boolean }[]): string {
  const ringing = vulns.filter((v) => !v.dev && (rank(v.severity) <= rank("high") || isRce(v.summary)));
  const sorted = [...ringing].sort((a, b) => rank(a.severity) - rank(b.severity) || (a.package < b.package ? -1 : 1));
  const names: string[] = [];
  for (const v of sorted) {
    const t = `${v.package} ${v.installedVersion}${v.fixedVersion ? ` → ${v.fixedVersion}` : " (no fix yet)"}`;
    if (!names.includes(t)) names.push(t);
  }
  const pkgs = new Set(ringing.map((v) => v.package)).size;
  const c = countBySeverity(ringing);
  const counts = (["critical", "high", "moderate", "low", "unknown"] as const).filter((s) => c[s] > 0).map((s) => `${c[s]} ${s}`).join(", ");
  const text = `${plural(pkgs, "vulnerable package")} (${counts}): ${names.slice(0, 4).join(", ")}${names.length > 4 ? `, +${names.length - 4} more` : ""}.`;
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

// The upgrades that fix an app's open advisories, per direct package: the highest fixed version any of its advisories
// names (above the installed one). Packages without a fix, or only reached through another package, are left out.
export type Upgrade = { package: string; to: string; vulnIds: string[]; cves: string[]; severity: DepSeverity };
export function upgradesFor(vulns: Pick<OpenVuln, "package" | "installedVersion" | "fixedVersion" | "vulnId" | "aliases" | "severity" | "direct">[]): Upgrade[] {
  const by = new Map<string, Upgrade>();
  for (const v of vulns) {
    if (!v.direct || !v.fixedVersion || compareVersions(v.fixedVersion, v.installedVersion) <= 0) continue;
    const u = by.get(v.package) ?? { package: v.package, to: v.fixedVersion, vulnIds: [], cves: [], severity: v.severity };
    if (compareVersions(v.fixedVersion, u.to) > 0) u.to = v.fixedVersion;
    if (!u.vulnIds.includes(v.vulnId)) u.vulnIds.push(v.vulnId);
    for (const a of v.aliases) if (/^CVE-/.test(a) && !u.cves.includes(a)) u.cves.push(a);
    if (rank(v.severity) < rank(u.severity)) u.severity = v.severity;
    by.set(v.package, u);
  }
  return [...by.values()].sort((a, b) => rank(a.severity) - rank(b.severity) || (a.package < b.package ? -1 : 1));
}
