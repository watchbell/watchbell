// Watchbell 1.2.1 (owner 24 Oct): does a successful dependency scan cover the app? "None known" is only shown when one
// does; otherwise the Dependencies card says "Not scanned" and why. A scan row with no lockfile path and no packages is
// either a failed first scan or a repository with no package.json/lockfile, so it covers nothing. A later failure
// keeps the earlier successful scan (lockfile path and packages stay), shown with the failure.

export type DepsScanRow = { scannedAt: Date | null; lockfilePath: string | null; packageCount: number; error: string | null; note?: string | null };
export type NotScannedReason = "no-repo" | "devops-off" | "failed" | "no-lockfile" | "not-yet";
export type DepsCoverage = { scanned: true; paused: boolean } | { scanned: false; reason: NotScannedReason };

export function depsCoverage(view: { repo: unknown; scan: DepsScanRow | null }, devopsOff: boolean): DepsCoverage {
  if (!view.repo) return { scanned: false, reason: "no-repo" };
  const s = view.scan;
  if (s?.scannedAt && (s.lockfilePath || s.packageCount > 0)) return { scanned: true, paused: devopsOff };
  if (devopsOff) return { scanned: false, reason: "devops-off" };
  if (s?.scannedAt && s.error) return { scanned: false, reason: "failed" };
  if (s?.scannedAt) return { scanned: false, reason: "no-lockfile" };
  return { scanned: false, reason: "not-yet" };
}

// The card's sentence after "Not scanned:".
export const NOT_SCANNED_TEXT: Record<NotScannedReason, string> = {
  "no-repo": "no linked repository. Link one (Repository card below) to scan its lockfile for known vulnerabilities.",
  "devops-off": "DevOps is off (Manage › Sections), so Watchbell doesn't read GitHub. Turn it on to scan the linked repository.",
  failed: "the scan failed.",
  "no-lockfile": "no lockfile or package.json was found in the linked repository.",
  "not-yet": "the daily run scans linked repositories; Scan now does it at once.",
};
