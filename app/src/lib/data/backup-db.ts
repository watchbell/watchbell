import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, alerts, backups, deployments, events, monitors, resources, rollupsHourly, settings, snapshots } from "@/db/schema";
import type { BackupInput, DatabaseRow, DomainRow } from "@/lib/backup/content";
import { monthRange } from "@/lib/backup/content";
import { openOrNull } from "@/lib/crypto";
import { readData } from "@/lib/databases/snapshot-data";
import { firebaseData, neonData, supabaseData } from "@/lib/databases/snapshot-data";
import { serverEnv } from "@/lib/env";
import { DB_KINDS } from "@/lib/links";
import { readAliasBook } from "./aliases-db";
import { listDomains } from "./network-db";

// Stage 7: the backups' rows in the console database. Reads are bounded (R8); nothing here calls Google.

export type BackupRow = typeof backups.$inferSelect;
export type DriveAccount = { id: string; status: "ok" | "error"; lastError: string | null; lastTestAt: Date | null; refreshToken: string | null };

const FOLDER_KEY = "backup.folder";
// Far beyond one owner's months, and enough rows for a month of ~20 monitors (14,400 rollups) with room to spare.
const MAX_ROLLUPS = 50_000;
const MAX_EVENTS = 50_000;
const MAX_ALERTS = 5_000;
const MAX_DEPLOYS = 10_000;

// The single Google Drive connection, with its refresh token opened (null when the key changed). Null: not connected.
export async function driveAccount(): Promise<DriveAccount | null> {
  const [a] = await db().select().from(accounts).where(eq(accounts.provider, "drive")).orderBy(asc(accounts.createdAt)).limit(1);
  if (!a) return null;
  const refreshToken = openOrNull({ ciphertext: a.credentialCiphertext, iv: a.credentialIv }, serverEnv().OPS_ENCRYPTION_KEY);
  return { id: a.id, status: a.status, lastError: a.lastError, lastTestAt: a.lastTestAt, refreshToken };
}

// The Backups page and Connections: whether Drive is connected and how it is, without opening the token.
export async function driveStatus(): Promise<{ status: "ok" | "error"; lastError: string | null; connectedAt: Date } | null> {
  const [a] = await db().select({ status: accounts.status, lastError: accounts.lastError, connectedAt: accounts.updatedAt }).from(accounts)
    .where(eq(accounts.provider, "drive")).orderBy(asc(accounts.createdAt)).limit(1);
  return a ?? null;
}

// B2: invalid_grant (or an unreadable token) marks the account; the CredentialExpiring rule fires on "invalid_grant".
export async function markDrive(accountId: string, change: { status: "ok"; lastError: null } | { status: "error"; lastError: string }): Promise<void> {
  const now = new Date();
  await db().update(accounts).set({ ...change, lastTestAt: now, updatedAt: now }).where(eq(accounts.id, accountId));
}

// B1: the one Drive account row, created or replaced by a successful connect.
export async function saveDriveAccount(sealed: { ciphertext: string; iv: string; keyVersion: number }): Promise<void> {
  const now = new Date();
  const values = {
    credentialCiphertext: sealed.ciphertext, credentialIv: sealed.iv, keyVersion: sealed.keyVersion, credentialKind: "OAuth refresh token",
    scopeNote: "drive.file: only the files it creates", status: "ok" as const, lastError: null, lastTestAt: now, updatedAt: now,
  };
  const [existing] = await db().select({ id: accounts.id }).from(accounts).where(eq(accounts.provider, "drive")).limit(1);
  if (existing) await db().update(accounts).set(values).where(eq(accounts.id, existing.id));
  else await db().insert(accounts).values({ provider: "drive", label: "Google Drive", ...values });
}

// Forgets the connection in the console only: the refresh token is deleted here, nothing changes at Google.
export async function removeDriveAccount(): Promise<boolean> {
  const gone = await db().delete(accounts).where(eq(accounts.provider, "drive")).returning({ id: accounts.id });
  return gone.length > 0;
}

export async function listBackups(): Promise<BackupRow[]> {
  return db().select().from(backups).orderBy(desc(backups.month)).limit(120);
}

export async function getBackup(month: string): Promise<BackupRow | null> {
  const [row] = await db().select().from(backups).where(eq(backups.month, month)).limit(1);
  return row ?? null;
}

export type BackupPatch = Partial<Omit<BackupRow, "id" | "month" | "createdAt">>;

export async function saveBackup(month: string, patch: BackupPatch & { status: BackupRow["status"] }): Promise<void> {
  const now = new Date();
  await db().insert(backups).values({ month, ...patch, updatedAt: now })
    .onConflictDoUpdate({ target: backups.month, set: { ...patch, updatedAt: now } });
}

// The backups folder: its id, and its name in Drive once a backup run has seen it (null for a folder stored before
// the name was recorded).
export type StoredFolder = { id: string; name: string | null };

export async function readFolder(): Promise<StoredFolder | null> {
  const [row] = await db().select().from(settings).where(eq(settings.key, FOLDER_KEY)).limit(1);
  const v = row?.value as { id?: unknown; name?: unknown } | undefined;
  if (typeof v?.id !== "string" || !v.id) return null;
  return { id: v.id, name: typeof v.name === "string" && v.name ? v.name : null };
}

export async function readFolderId(): Promise<string | null> {
  return (await readFolder())?.id ?? null;
}

export async function saveFolderId(id: string, name?: string | null): Promise<void> {
  const value = name ? { id, name } : { id };
  await db().insert(settings).values({ key: FOLDER_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

const pathOf = (m: { kind: string; name: string | null; url: string }) => {
  if (m.kind === "heartbeat") return ` heartbeat ${m.name ?? ""}`.trimEnd();
  try {
    return new URL(m.url).pathname;
  } catch {
    return m.url;
  }
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Everything one month's backup needs, as plain rows (content.ts builds the tabs and the CSV). `until`: a partial backup
// reads up to now; a full one to the month's end.
export async function readBackupInput(month: string, partial: boolean, now: Date): Promise<BackupInput> {
  const { start, end } = monthRange(month);
  const until = partial && now < end ? now : end;
  const [book, appRows, rollRows, eventRows, alertRows, deployRows, dbRows, domainViews] = await Promise.all([
    readAliasBook(),
    db().select({ id: resources.id, name: resources.name }).from(resources)
      .where(and(eq(resources.kind, "app"), eq(resources.monitored, true), isNull(resources.goneAt))).orderBy(asc(resources.name)).limit(500),
    db().select({ r: rollupsHourly, appId: monitors.resourceId, app: resources.name, url: monitors.url, kind: monitors.kind, name: monitors.name })
      .from(rollupsHourly).innerJoin(monitors, eq(monitors.id, rollupsHourly.monitorId)).innerJoin(resources, eq(resources.id, monitors.resourceId))
      .where(and(gte(rollupsHourly.hour, start), lt(rollupsHourly.hour, until))).orderBy(asc(rollupsHourly.hour)).limit(MAX_ROLLUPS),
    db().select({ e: events, resource: resources.name }).from(events).leftJoin(resources, eq(resources.id, events.resourceId))
      .where(and(gte(events.at, start), lt(events.at, until))).orderBy(asc(events.at)).limit(MAX_EVENTS),
    db().select().from(alerts).where(and(gte(alerts.startedAt, start), lt(alerts.startedAt, until))).orderBy(asc(alerts.startedAt)).limit(MAX_ALERTS),
    db().select({ appId: deployments.resourceId, target: deployments.target, state: deployments.state, createdAt: deployments.createdAtProvider }).from(deployments)
      .where(and(gte(deployments.createdAtProvider, start), lt(deployments.createdAtProvider, until))).limit(MAX_DEPLOYS),
    db().select({ r: resources, s: snapshots, account: accounts.label }).from(resources)
      .innerJoin(accounts, eq(accounts.id, resources.accountId)).leftJoin(snapshots, eq(snapshots.resourceId, resources.id))
      .where(and(inArray(resources.kind, [...DB_KINDS]), eq(resources.monitored, true), isNull(resources.goneAt))).limit(500),
    listDomains(),
  ]);
  const databases: DatabaseRow[] = dbRows.map(({ r, s, account }) => {
    const data = s?.data ?? {};
    const kind = r.kind as DatabaseRow["kind"];
    const neon = kind === "neon_project" ? readData(neonData, data) : null;
    const size = kind === "supabase_project" ? num(readData(supabaseData, data).sizeBytes)
      : neon ? (neon.branches ?? []).reduce<number | null>((t, b) => (b.logicalSize === null ? t : (t ?? 0) + b.logicalSize), null) : null;
    return {
      id: r.id, kind, account, state: s?.state ?? "unknown", sizeBytes: size,
      cuHours: neon && num(neon.computeSeconds) !== null ? Math.round((neon.computeSeconds! / 3600) * 10) / 10 : null,
      reads: kind === "firestore" ? num(readData(firebaseData, data).reads) : null,
    };
  });
  const domains: DomainRow[] = domainViews.map((d) => ({
    name: d.name, app: d.appName, tlsExpires: d.tls?.notAfter ?? null, domainExpires: d.rdap?.expiresAt ?? null, registrar: d.rdap?.registrar ?? null,
  }));
  return {
    month, partial, generatedAt: now, book, apps: appRows,
    rollups: rollRows.map(({ r, appId, app, url, kind, name }) => ({
      monitorId: r.monitorId, appId, app, path: pathOf({ kind, name, url }), hour: r.hour, checks: r.checks, failures: r.failures,
      p50Ms: r.p50Ms, p95Ms: r.p95Ms, maxMs: r.maxMs, status5xx: r.status5xx, maintenance: r.maintenance,
    })),
    events: eventRows.map(({ e, resource }) => ({
      at: e.at, resourceId: e.resourceId, resource, type: e.type, kind: e.kind, reason: e.reason, count: e.count, message: e.message, detail: e.detail,
    })),
    alerts: alertRows.map((a) => ({ ruleKey: a.ruleKey, severity: a.severity, title: a.title, message: a.message, resourceId: a.resourceId, startedAt: a.startedAt, resolvedAt: a.resolvedAt })),
    deployments: deployRows,
    databases, domains,
  };
}
