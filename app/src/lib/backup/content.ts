import { gzipSync } from "node:zlib";
import { type AliasBook, dbAlias, hideAlert, hideEmails, hideNames } from "@/lib/view/display-name";
import type { Cell, Tab } from "./drive";

// B3: what one monthly backup contains, from plain rows (lib/data/backup-db.ts reads them). Pure: no database, no
// network. Every text built from names goes through the console's privacy rules (lib/view/display-name.ts): a
// database is its alias (db-a), names in free text are replaced, emails are hidden.

// The folder a NEW connection creates. A folder the console already uses stays as it is (its id is stored, see
// lib/backup/run.ts): installs from before the Watchbell rename keep their "Watchpost backups" folder, never renamed
// or recreated, and it is still found by its old name if the stored id is lost.
export const FOLDER_NAME = "Watchbell backups";
export const LEGACY_FOLDER_NAME = "Watchpost backups";

// The folder's name as the console shows it: the stored folder's real name; for a folder stored before names were
// recorded, the name the console gave it then (the next backup run records the real one); with no folder yet, the
// name the first backup will give it.
export const folderLabel = (stored: { name: string | null } | null): string =>
  stored ? (stored.name ?? LEGACY_FOLDER_NAME) : FOLDER_NAME;
export const TABS = ["Overview", "Applications", "Incidents", "Databases", "Domains"] as const;
export const KEEP_MONTHS = 3;

const WIB_MS = 7 * 3_600_000; // Asia/Jakarta has no daylight saving
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const isMonth = (v: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

// The WIB calendar month a moment falls in ("2026-10"). The 03:00 WIB daily run on 1 Nov is 20:00 UTC on 31 Oct, and
// belongs to November.
export function monthOf(d: Date): string {
  const w = new Date(d.getTime() + WIB_MS);
  return `${w.getUTCFullYear()}-${String(w.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthRange(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1) - WIB_MS), end: new Date(Date.UTC(y, m, 1) - WIB_MS) };
}

export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export const sheetTitle = (month: string) => `Watchbell · ${month}`;
export const csvName = (month: string) => `watchbell-${month}-raw.csv.gz`;

// "2026-10-01 03:00" in WIB: sortable, and what the owner reads everywhere else in the console.
export function wibStamp(d: Date | null): string {
  if (!d) return "";
  const w = new Date(d.getTime() + WIB_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${w.getUTCFullYear()}-${p(w.getUTCMonth() + 1)}-${p(w.getUTCDate())} ${p(w.getUTCHours())}:${p(w.getUTCMinutes())}`;
}

export type RollupRow = {
  monitorId: string; appId: string; app: string; path: string; hour: Date;
  checks: number; failures: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null; status5xx: number; maintenance: number;
};
export type EventRow = {
  at: Date; resourceId: string | null; resource: string | null; type: string; kind: string; reason: string | null; count: number;
  message: string; detail: string | null;
};
export type AlertRow = { ruleKey: string; severity: string; title: string; message: string; resourceId: string | null; startedAt: Date; resolvedAt: Date | null };
export type DeployRow = { appId: string; target: string | null; state: string; createdAt: Date };
export type DatabaseRow = {
  id: string; kind: "supabase_project" | "neon_project" | "firestore"; account: string; state: string;
  sizeBytes: number | null; cuHours: number | null; reads: number | null;
};
export type DomainRow = { name: string; app: string | null; tlsExpires: string | null; domainExpires: string | null; registrar: string | null };

export type BackupInput = {
  month: string; partial: boolean; generatedAt: Date; book: AliasBook;
  apps: { id: string; name: string }[];
  rollups: RollupRow[]; events: EventRow[]; alerts: AlertRow[]; deployments: DeployRow[];
  databases: DatabaseRow[]; domains: DomainRow[];
};

const pct = (checks: number, failures: number): Cell => (checks > 0 ? Math.round(((checks - failures) / checks) * 100_000) / 1000 : "");
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const isProduction = (d: DeployRow) => d.target === "production";
const failed = (d: DeployRow) => d.state === "ERROR";
const PROVIDER_NAME = { supabase_project: "Supabase", neon_project: "Neon", firestore: "Firebase" } as const;

function duration(start: Date, end: Date | null, until: Date): string {
  const ms = (end ?? until).getTime() - start.getTime();
  const min = Math.max(0, Math.round(ms / 60_000));
  const text = min < 60 ? `${min} min` : min < 2880 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${Math.round(min / 1440)} days`;
  return end ? text : `${text} (still open)`;
}

function daysLeft(iso: string | null, at: Date): Cell {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((t - at.getTime()) / 86_400_000) : "";
}

const mb = (bytes: number | null): Cell => (bytes === null ? "" : Math.round((bytes / 1_048_576) * 10) / 10);

export function buildTabs(i: BackupInput): Tab[] {
  const { start, end } = monthRange(i.month);
  const until = i.partial && i.generatedAt < end ? i.generatedAt : end;
  const prod = i.deployments.filter(isProduction);
  const checks = sum(i.rollups.map((r) => r.checks));
  const failures = sum(i.rollups.map((r) => r.failures));
  const name = (s: string) => hideEmails(s);

  const overview: Cell[][] = [
    ["Watchbell backup", i.month],
    ["Covers", `${wibStamp(start)} to ${wibStamp(until)} WIB${i.partial ? " (month so far)" : ""}`],
    ["Kind", i.partial ? "Partial: Back up now" : "Full month"],
    ["Generated", `${wibStamp(i.generatedAt)} WIB`],
    [],
    ["Applications watched", i.apps.length],
    ["Uptime, all monitors (%)", pct(checks, failures)],
    ["Checks (rolled-up hours)", checks],
    ["Failed checks", failures],
    ["Incidents (alerts opened)", i.alerts.length],
    ["Critical incidents", i.alerts.filter((a) => a.severity === "critical").length],
    ["Production deployments", prod.length],
    ["Failed production deployments", prod.filter(failed).length],
    ["Events", sum(i.events.map((e) => e.count))],
  ];

  const applications: Cell[][] = [["Application", "Monitors", "Checks", "Uptime (%)", "p95 response, typical hour (ms)", "p95 response, worst hour (ms)", "5xx responses", "Production deploys", "Failed production deploys"]];
  for (const app of [...i.apps].sort((a, b) => a.name.localeCompare(b.name))) {
    const rs = i.rollups.filter((r) => r.appId === app.id);
    const p95 = rs.map((r) => r.p95Ms).filter((v): v is number => v !== null);
    const deploys = prod.filter((d) => d.appId === app.id);
    applications.push([
      name(app.name), new Set(rs.map((r) => r.monitorId)).size, sum(rs.map((r) => r.checks)), pct(sum(rs.map((r) => r.checks)), sum(rs.map((r) => r.failures))),
      median(p95), p95.length ? Math.max(...p95) : null, sum(rs.map((r) => r.status5xx)), deploys.length, deploys.filter(failed).length,
    ]);
  }

  const incidents: Cell[][] = [["Rule", "Severity", "Subject", "Started (WIB)", "Resolved (WIB)", "Duration", "Message"]];
  for (const a of [...i.alerts].sort((x, y) => x.startedAt.getTime() - y.startedAt.getTime())) {
    const shown = hideAlert({ title: a.title, message: a.message, causedBy: null, resourceId: a.resourceId }, i.book);
    incidents.push([a.ruleKey, a.severity, shown.title, wibStamp(a.startedAt), wibStamp(a.resolvedAt), duration(a.startedAt, a.resolvedAt, until), shown.message]);
  }

  const databases: Cell[][] = [["Database", "Provider", "Account", "State at backup", "Status changes this month", "Size (MB)", "Neon CU-hours this period", "Firestore reads (last reading)"]];
  for (const d of [...i.databases].sort((a, b) => dbAlias(i.book, a.id).localeCompare(dbAlias(i.book, b.id)))) {
    const changes = sum(i.events.filter((e) => e.type === "database" && e.resourceId === d.id).map((e) => e.count));
    databases.push([dbAlias(i.book, d.id), PROVIDER_NAME[d.kind], name(d.account), d.state, changes, mb(d.sizeBytes), d.cuHours, d.reads]);
  }

  const domains: Cell[][] = [["Domain", "Application", "TLS certificate expires", "TLS days left at month end", "Domain expires (RDAP)", "Domain days left at month end", "Registrar"]];
  for (const d of [...i.domains].sort((a, b) => a.name.localeCompare(b.name))) {
    domains.push([d.name, d.app ? name(d.app) : "", d.tlsExpires ?? "", daysLeft(d.tlsExpires, until), d.domainExpires ?? "", daysLeft(d.domainExpires, until), d.registrar ?? ""]);
  }

  return [
    { title: "Overview", rows: overview }, { title: "Applications", rows: applications }, { title: "Incidents", rows: incidents },
    { title: "Databases", rows: databases }, { title: "Domains", rows: domains },
  ];
}

// RFC 4180 quoting. A text cell that a spreadsheet would read as a formula (=, +, -, @, tab, CR) gets a leading
// apostrophe: commit messages and provider text end up in here.
export function csvCell(v: Cell): string {
  if (v === null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const CSV_HEADER = ["record", "at", "subject", "resource_id", "checks", "failures", "p50_ms", "p95_ms", "max_ms", "status_5xx", "maintenance",
  "type", "kind", "reason", "count", "message", "detail"] as const;

// One CSV for both kinds of rows (spec §11: "that month's hourly rollups and events"); `record` says which columns apply.
export function rawCsv(i: Pick<BackupInput, "rollups" | "events" | "book">): string {
  const lines = [CSV_HEADER.join(",")];
  for (const r of [...i.rollups].sort((a, b) => a.hour.getTime() - b.hour.getTime() || a.monitorId.localeCompare(b.monitorId))) {
    lines.push(["rollup", r.hour.toISOString(), hideEmails(`${r.app}${r.path}`), r.appId, r.checks, r.failures, r.p50Ms, r.p95Ms, r.maxMs, r.status5xx, r.maintenance,
      null, null, null, null, null, null].map(csvCell).join(","));
  }
  for (const e of [...i.events].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const isDb = !!e.resourceId && i.book.db.some((d) => d.id === e.resourceId);
    const subject = isDb ? dbAlias(i.book, e.resourceId!) : hideNames(e.resource ?? "", i.book);
    lines.push(["event", e.at.toISOString(), subject, e.resourceId, null, null, null, null, null, null, null,
      e.type, e.kind, e.reason, e.count, hideNames(e.message, i.book, e.resourceId), hideNames(e.detail, i.book, e.resourceId)].map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export const gzipCsv = (csv: string): Buffer => gzipSync(Buffer.from(csv, "utf8"), { level: 9 });

// B4: which month the daily step should write now, if any. The last complete WIB month first; else the newest month
// among the last KEEP_MONTHS complete ones whose last attempt failed (a retry). One month per run.
export function dueMonth(rows: { month: string; status: string }[], now: Date): string | null {
  const last = previousMonth(monthOf(now));
  const byMonth = new Map(rows.map((r) => [r.month, r.status]));
  if (byMonth.get(last) !== "ok") return last;
  let m = last;
  for (let k = 1; k < KEEP_MONTHS; k++) {
    m = previousMonth(m);
    if (byMonth.get(m) === "error") return m;
  }
  return null;
}

// B5: the rows whose files go to Drive's trash: complete months (status ok) beyond the KEEP_MONTHS newest, plus any other
// row (a failed or partial attempt) older than the oldest kept month. Never the current month, never twice.
export function retentionPlan<R extends { month: string; status: string; trashedAt: Date | null; sheetFileId: string | null; csvFileId: string | null }>(rows: R[], now: Date): R[] {
  const current = monthOf(now);
  const kept = rows.filter((r) => r.status === "ok" && r.month < current).map((r) => r.month).sort().reverse().slice(0, KEEP_MONTHS);
  if (kept.length < KEEP_MONTHS) return [];
  const oldestKept = kept[kept.length - 1];
  return rows.filter((r) => !r.trashedAt && r.month < oldestKept && (r.sheetFileId || r.csvFileId));
}

// "Next backup": the 1st of the month after the newest complete month, at the daily run (~03:00 WIB).
export function nextBackupMonth(rows: { month: string; status: string }[], now: Date): { runsOn: string; covers: string } {
  const due = dueMonth(rows, now);
  const current = monthOf(now);
  return due ? { runsOn: "the next daily run (~03:00 WIB)", covers: monthLabel(due) } : { runsOn: `1 ${monthLabel(nextMonth(current))}, ~03:00 WIB`, covers: monthLabel(current) };
}
