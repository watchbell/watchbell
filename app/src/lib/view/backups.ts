import { KEEP_MONTHS, monthLabel } from "@/lib/backup/content";
import { downloadUrl, fileUrl, sheetUrl } from "@/lib/backup/drive";
import type { State } from "@/lib/status";
import { clock, dayMonth } from "@/lib/time";

// Backups page (mockup backups()) and the Drive card on Connections: pure helpers over what the page reads.

export type DriveState =
  | { kind: "env" } // GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set
  | { kind: "none" } // not connected
  | { kind: "ok" }
  | { kind: "reconnect"; error: string } // invalid_grant or an unreadable token
  | { kind: "problem"; error: string }; // last run failed for another reason; the connection itself is fine

export function driveState(env: boolean, account: { status: "ok" | "error"; lastError: string | null } | null): DriveState {
  if (!env) return { kind: "env" };
  if (!account) return { kind: "none" };
  if (account.status === "error") {
    const error = account.lastError ?? "Google Drive needs reconnecting.";
    return /invalid_grant|can't be read|Reconnect/i.test(error) ? { kind: "reconnect", error } : { kind: "problem", error };
  }
  return { kind: "ok" };
}

export function sizeText(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

const TRASH_DAYS = 30; // Drive empties its trash after 30 days (spec §11)

export type BackupView = {
  month: string; label: string; state: State; status: string; size: string; created: string;
  sheet: string | null; csv: string | null; download: string | null; note: string | null;
};

export function backupRows(rows: {
  month: string; status: string; sizeBytes: number | null; finishedAt: Date | null; trashedAt: Date | null;
  sheetFileId: string | null; csvFileId: string | null; error: string | null;
}[]): BackupView[] {
  return [...rows].sort((a, b) => b.month.localeCompare(a.month)).map((r) => {
    const created = r.finishedAt ? `${dayMonth(r.finishedAt)} ${clock(r.finishedAt)}` : "—";
    const base = { month: r.month, label: monthLabel(r.month), size: sizeText(r.sizeBytes), created };
    if (r.trashedAt) {
      const until = new Date(r.trashedAt.getTime() + TRASH_DAYS * 86_400_000);
      return { ...base, state: "off", status: `Moved to Drive trash on ${dayMonth(r.trashedAt)}`, sheet: null, csv: null, download: null, note: `Restorable from Drive trash until ${dayMonth(until)}` };
    }
    const links = { sheet: r.sheetFileId ? sheetUrl(r.sheetFileId) : null, csv: r.csvFileId ? fileUrl(r.csvFileId) : null, download: r.csvFileId ? downloadUrl(r.csvFileId) : null };
    if (r.status === "ok") return { ...base, ...links, state: "ok", status: "Saved", note: null };
    if (r.status === "partial") return { ...base, ...links, state: "info", status: "Month so far (Back up now)", note: r.error ? `Last try failed: ${r.error}` : "The full month is written on the 1st." };
    return { ...base, ...links, state: "err", status: "Failed", note: r.error ?? "The next daily run tries again." };
  });
}

export const WHATS_INSIDE: [string, string][] = [
  ["Overview", "Uptime, incidents, and deployments for the month"],
  ["Applications", "Uptime %, p95 response, 5xx count, deploys per app"],
  ["Incidents", "Every alert with start, end, and duration"],
  ["Databases", "Status changes, size, CU-hours, Firestore reads (databases by alias)"],
  ["Domains", "Certificate and registrar expiry at month end"],
  ["Raw data .csv.gz", "That month's hourly rollups and events"],
];

export const KEEP_TEXT = `${KEEP_MONTHS} months`;
