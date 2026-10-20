import { fixedInAll, isSevere, vulnerabilities, worstSeverity } from "@/lib/security/rules";
import type { SecurityRow, Severity } from "@/lib/security/types";
import type { State } from "@/lib/status";
import type { ProblemBanner } from "./labels";

// How the Next.js security check reads on the App page, Overview and the Applications list (mockup: Security card,
// vulnerable-app banner, CVE tag). Pages only read ops.app_security; nothing here runs a check.

export const SEVERITY_LABEL: Record<Severity, string> = { CRITICAL: "Critical", HIGH: "High", MODERATE: "Moderate", LOW: "Low", UNKNOWN: "Unknown" };

// Findings count while a failed check keeps the earlier ones, so an outage never hides a known vulnerability.
export const isVulnerable = (s: SecurityRow | null): s is SecurityRow => !!s && s.findings.length > 0;

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

export function securityBanners(apps: { id: string; name: string; gone: boolean; security: SecurityRow | null }[]): ProblemBanner[] {
  const out: ProblemBanner[] = [];
  for (const a of apps) {
    if (a.gone || !isVulnerable(a.security)) continue;
    const s = a.security;
    const worst = worstSeverity(s.findings);
    const fixed = fixedInAll(s.findings);
    out.push({
      key: `sec-${a.id}`, tone: isSevere(worst) ? "danger" : "warning",
      title: `${a.name} runs a vulnerable Next.js (${s.version ?? "unknown version"})`,
      body: `${vulnerabilities(s.findings.length)}, worst ${worst.toLowerCase()}.${fixed ? ` Fixed in ${fixed}.` : ""}`,
      action: { label: "Open app", href: `/apps/${a.id}` },
    });
  }
  return [...out.filter((b) => b.tone === "danger"), ...out.filter((b) => b.tone === "warning")];
}

// Applications list: a small tag next to the name.
export function cveTag(s: SecurityRow | null): { label: "CVE"; severe: boolean; title: string } | null {
  if (!isVulnerable(s)) return null;
  const worst = worstSeverity(s.findings);
  return { label: "CVE", severe: isSevere(worst), title: `Next.js ${s.version}: ${vulnerabilities(s.findings.length)}, worst ${worst.toLowerCase()}` };
}

// App page → Security card: the line under Next.js / Checked. Null when the findings table says it all.
export function securityNote(s: SecurityRow | null): { state: State; text: string } | null {
  if (!s) return { state: "unknown", text: "Not checked yet. The daily job checks at 03:00 WIB." };
  if (s.status === "ok") return { state: "ok", text: `No known vulnerabilities for Next.js ${s.version}.` };
  // unknown and error keep the previous version and findings; say so when there are some.
  const before = s.version !== null || s.findings.length > 0 ? " Showing the result from before." : "";
  if (s.status === "unknown") return { state: "unknown", text: `Couldn't read the Next.js version: ${sentence(s.reason ?? "no reason given")}${before}` };
  if (s.status === "error") return { state: "warn", text: `The last check failed: ${sentence(s.reason ?? "no reason given")}${before}` };
  return null;
}

// Check now → toast.
export function checkNowText(name: string, s: SecurityRow): string {
  if (s.status === "vulnerable") return `${name} runs Next.js ${s.version} with ${vulnerabilities(s.findings.length)}.`;
  if (s.status === "ok") return `No known vulnerabilities for Next.js ${s.version}.`;
  if (s.status === "unknown") return `Couldn't read the Next.js version: ${sentence(s.reason ?? "no reason given")}`;
  return `The check failed: ${sentence(s.reason ?? "no reason given")}`;
}
