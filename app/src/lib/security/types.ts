// The Next.js security check: one row per watched app in ops.app_security (spec "Next.js security check").

export const SEVERITIES = ["CRITICAL", "HIGH", "MODERATE", "LOW", "UNKNOWN"] as const;
export type Severity = (typeof SEVERITIES)[number];

// One OSV advisory for the running version. `fixed` is the first fixed version in the range that holds it.
export type Finding = { id: string; cve: string | null; summary: string; severity: Severity; fixed: string | null };

export const SECURITY_STATUSES = ["ok", "vulnerable", "unknown", "error"] as const;
export type SecurityStatus = (typeof SECURITY_STATUSES)[number];

export type SecurityRow = {
  version: string | null; status: SecurityStatus; findings: Finding[]; reason: string | null; checkedAt: Date;
};
