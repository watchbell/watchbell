import "server-only";
import * as store from "@/lib/data/backup-db";
import { csvName, dueMonth, FOLDER_NAME, gzipCsv, LEGACY_FOLDER_NAME, monthLabel, rawCsv, buildTabs, retentionPlan, sheetTitle, TABS } from "./content";
import * as drive from "./drive";
import { DRIVE_ENV_MISSING, driveEnv, INVALID_GRANT, refreshAccessToken } from "./google-oauth";

// B4: one backup run for one month. Resumable: every Drive id is stored on the month's row as soon as the file exists,
// and no new call starts after `deadline`, so a run that stops half-way is continued by the next one instead of making
// a second copy. A failure leaves status 'error' (retried by the next daily run, see dueMonth).

export type BackupOutcome =
  | { ok: true; month: string; message: string; retention: string | null }
  | { ok: false; month: string; kind: "env" | "not-connected" | "revoked" | "time" | "failed"; error: string };

type Opts = { fetch?: typeof fetch };
const TIME_UP = "Stopped at the daily job's time budget; the next daily run continues where this one stopped.";

class Stop extends Error {
  constructor(public kind: "revoked" | "time" | "failed", message: string) {
    super(message);
  }
}

export async function runBackup(p: { month: string; partial: boolean; now: Date; deadline: number } & Opts): Promise<BackupOutcome> {
  const { month, partial, now } = p;
  const env = driveEnv();
  if (!env) return { ok: false, month, kind: "env", error: DRIVE_ENV_MISSING };
  const account = await store.driveAccount();
  if (!account) return { ok: false, month, kind: "not-connected", error: "Google Drive isn't connected." };
  if (!account.refreshToken) {
    const error = "The stored Google Drive token can't be read (the encryption key changed). Reconnect Google Drive.";
    await store.markDrive(account.id, { status: "error", lastError: error });
    return { ok: false, month, kind: "failed", error };
  }

  const existing = await store.getBackup(month);
  let row = {
    sheetFileId: existing?.sheetFileId ?? null, csvFileId: existing?.csvFileId ?? null, driveFolderId: existing?.driveFolderId ?? null,
  };
  // While running, the row keeps the status it had (a partial backup stays readable); the end sets the real one.
  const holding = existing?.status ?? "error";
  await store.saveBackup(month, { status: holding, attempts: (existing?.attempts ?? 0) + 1, startedAt: now });
  const save = (patch: Partial<typeof row>) => {
    row = { ...row, ...patch };
    return store.saveBackup(month, { status: holding, ...patch });
  };
  const opts = { fetch: p.fetch };
  const inTime = () => {
    if (Date.now() > p.deadline) throw new Stop("time", TIME_UP);
  };
  const must = <T>(r: drive.DriveResult<T>): T => {
    if (!r.ok) throw new Stop("failed", r.error);
    return r.data;
  };

  try {
    const token = await refreshAccessToken(env, account.refreshToken, opts);
    if (!token.ok) {
      if (token.kind === "revoked") {
        await store.markDrive(account.id, { status: "error", lastError: INVALID_GRANT });
        throw new Stop("revoked", INVALID_GRANT);
      }
      throw new Stop("failed", token.error);
    }
    if (account.status === "error") await store.markDrive(account.id, { status: "ok", lastError: null });
    const at = token.accessToken;

    // The folder: the stored one while it exists (never renamed), else the console's own folder found by name (also its
    // name from before the Watchbell rename), else a new one.
    inTime();
    const stored = await store.readFolder();
    let folderId = stored?.id ?? null;
    if (stored) {
      const state = must(await drive.folderState(at, stored.id, opts));
      if (!state.usable) folderId = null;
      // Remember the folder's real name for the Backups page (an id stored before names were recorded has none).
      else if (state.name && state.name !== stored.name) await store.saveFolderId(stored.id, state.name);
    }
    if (!folderId) {
      inTime();
      const found = must(await drive.findFolder(at, FOLDER_NAME, opts));
      const legacy = found ? null : must(await drive.findFolder(at, LEGACY_FOLDER_NAME, opts));
      folderId = found ?? legacy ?? must(await drive.createFolder(at, FOLDER_NAME, opts));
      await store.saveFolderId(folderId, legacy ? LEGACY_FOLDER_NAME : FOLDER_NAME);
    }

    const input = await store.readBackupInput(month, partial, now);

    // The spreadsheet: made once, then its tabs and values are (re)written. A sheet the owner deleted is made again.
    inTime();
    if (!row.sheetFileId) await save({ sheetFileId: must(await drive.createSpreadsheetFile(at, sheetTitle(month), folderId, opts)), driveFolderId: folderId });
    inTime();
    let tabs = await drive.ensureTabs(at, row.sheetFileId!, TABS, opts);
    if (!tabs.ok && tabs.kind === "missing") {
      await save({ sheetFileId: must(await drive.createSpreadsheetFile(at, sheetTitle(month), folderId, opts)), driveFolderId: folderId });
      inTime();
      tabs = await drive.ensureTabs(at, row.sheetFileId!, TABS, opts);
    }
    must(tabs);
    inTime();
    must(await drive.writeTabs(at, row.sheetFileId!, buildTabs(input), opts));

    inTime();
    const gz = gzipCsv(rawCsv(input));
    const up = must(await drive.uploadFile(at, { name: csvName(month), mimeType: "application/gzip", folderId, content: gz, fileId: row.csvFileId }, opts));
    await save({ csvFileId: up.id });

    await store.saveBackup(month, { status: partial ? "partial" : "ok", sizeBytes: up.size, error: null, finishedAt: new Date() });
    const retention = partial ? null : await applyRetention(at, now, p.deadline, opts);
    return { ok: true, month, retention, message: `${monthLabel(month)}${partial ? " so far" : ""} saved to Google Drive.` };
  } catch (e) {
    const stop = e instanceof Stop ? e : new Stop("failed", "The backup failed. The next daily run tries again.");
    if (!(e instanceof Stop)) console.error("backup failed:", e instanceof Error ? e.name : "unknown");
    // A failed "Back up now" keeps an earlier partial copy readable; a failed monthly run is 'error', so it is retried.
    const status = partial && holding === "partial" ? "partial" : "error";
    await store.saveBackup(month, { status, error: stop.message.slice(0, 500), finishedAt: new Date() }).catch(() => undefined);
    return { ok: false, month, kind: stop.kind, error: stop.message };
  }
}

// B5: months beyond the three newest complete ones go to Drive's trash (Drive deletes them for good 30 days later).
// Not finishing in time is fine: the next successful backup trashes the rest.
async function applyRetention(token: string, now: Date, deadline: number, opts: Opts): Promise<string | null> {
  const plan = retentionPlan(await store.listBackups(), now);
  const done: string[] = [];
  for (const r of plan) {
    if (Date.now() > deadline) break;
    let ok = true;
    for (const id of [r.sheetFileId, r.csvFileId]) {
      if (!id) continue;
      const t = await drive.trashFile(token, id, opts);
      if (!t.ok) ok = false;
    }
    if (ok) {
      await store.saveBackup(r.month, { status: r.status, trashedAt: now });
      done.push(monthLabel(r.month));
    }
  }
  return done.length ? `Moved to Drive trash: ${done.join(", ")}.` : null;
}

// The daily job's step: nothing unless Drive is connected, healthy and a month is due. Never throws; returns the
// problem to report (null when there is none).
export async function monthlyBackupStep(now: Date, deadline: number, opts: Opts = {}): Promise<string | null> {
  const account = await store.driveAccount();
  if (!account) return null;
  // A revoked grant only comes back with Reconnect; the CredentialExpiring alert already says so every day.
  if (account.status === "error" && account.lastError?.startsWith("invalid_grant")) return null;
  const month = dueMonth(await store.listBackups(), now);
  if (!month) return null;
  const r = await runBackup({ month, partial: false, now, deadline, ...opts });
  return r.ok ? null : `${monthLabel(month)}: ${r.error}`;
}
