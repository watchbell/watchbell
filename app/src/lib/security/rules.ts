import { compareVersions } from "./semver";
import type { Finding, SecurityRow, Severity } from "./types";

const RANK: Record<Severity, number> = { CRITICAL: 4, HIGH: 3, MODERATE: 2, LOW: 1, UNKNOWN: 0 };

export const severityRank = (s: Severity): number => RANK[s];

export function worstSeverity(findings: Finding[]): Severity {
  return findings.reduce<Severity>((w, f) => (RANK[f.severity] > RANK[w] ? f.severity : w), "UNKNOWN");
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => RANK[b.severity] - RANK[a.severity] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// CRITICAL and HIGH are errors (red); anything lower is a warning.
export const isSevere = (s: Severity): boolean => RANK[s] >= RANK.HIGH;

// The first version that clears every finding: the highest of the per-finding fixes. Null when none has a fix.
export function fixedInAll(findings: Finding[]): string | null {
  return findings.reduce<string | null>((best, f) => (f.fixed && (best === null || compareVersions(f.fixed, best) > 0) ? f.fixed : best), null);
}

export const vulnerabilities = (n: number) => `${n} known vulnerabilit${n === 1 ? "y" : "ies"}`;

export type SecurityEvent = { kind: "err" | "warn" | "ok"; message: string; detail: string | null };

// An event only when something changes: the app newly becomes vulnerable or gets a new finding id, or it is clean
// again. A failed check keeps the previous findings, and a version it can't read is not "clean", so neither says so.
export function securityEvent(app: string, prev: SecurityRow | null, next: SecurityRow): SecurityEvent | null {
  const before = new Set((prev?.findings ?? []).map((f) => f.id));
  if (next.status === "vulnerable" && next.findings.length > 0) {
    if (next.findings.every((f) => before.has(f.id))) return null;
    const worst = worstSeverity(next.findings);
    return {
      kind: isSevere(worst) ? "err" : "warn",
      message: `${app} runs Next.js ${next.version} with ${vulnerabilities(next.findings.length)} (${worst.toLowerCase()})`,
      detail: next.findings.map((f) => f.id).join(", ").slice(0, 1000),
    };
  }
  if (next.status === "ok" && before.size > 0) {
    return { kind: "ok", message: `${app} no longer has known Next.js vulnerabilities (now ${next.version})`, detail: null };
  }
  return null;
}
