import { z } from "zod";
import type { FetchOpts } from "./google-oauth";

// Drive v3 and Sheets v4 over plain fetch (spec §11: no googleapis SDK). With the drive.file scope the token sees only
// the files the console created. The only writes (B2/rule 2): create a folder, create a spreadsheet file, Sheets
// structure and values updates, a multipart upload (create or update) of the CSV, and files.update {trashed: true}.
// Nothing here sends DELETE or empties the trash.

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

export type DriveFailure = { ok: false; kind: "auth" | "missing" | "full" | "transient" | "format"; error: string; status?: number };
export type DriveResult<T> = { ok: true; data: T } | DriveFailure;
type Method = "GET" | "POST" | "PATCH";

export const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
export const fileUrl = (id: string) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
export const downloadUrl = (id: string) => `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
export const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;

const googleError = z.object({ error: z.object({ errors: z.array(z.looseObject({ reason: z.string().optional() })).optional(), status: z.string().optional() }) });

async function call(method: Method, url: string, token: string, body: { json?: unknown; raw?: Buffer; contentType?: string } | null, opts: FetchOpts): Promise<DriveResult<unknown>> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  let payload: string | Uint8Array<ArrayBuffer> | undefined;
  if (body?.raw) {
    headers["Content-Type"] = body.contentType ?? "application/octet-stream";
    payload = new Uint8Array(body.raw);
  } else if (body && body.json !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body.json);
  }
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, kind: "transient", error: timedOut ? `Google Drive didn't answer within ${Math.round(timeoutMs / 1000)} seconds.` : "Couldn't reach Google Drive." };
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok) return { ok: true, data: json };
  const g = googleError.safeParse(json);
  const reason = g.success ? g.data.error.errors?.find((x) => x.reason)?.reason ?? g.data.error.status : undefined;
  if (res.status === 401) return { ok: false, kind: "auth", status: 401, error: "Google Drive rejected the access token (401)." };
  if (res.status === 404) return { ok: false, kind: "missing", status: 404, error: "Google Drive doesn't know this file (404)." };
  if (res.status === 403 && reason === "storageQuotaExceeded") return { ok: false, kind: "full", status: 403, error: "Your Google Drive is full. Free some space; the next run tries again." };
  if (res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimit/i.test(reason ?? ""))) {
    return { ok: false, kind: "transient", status: res.status, error: `Google Drive is busy (${res.status}). The next run tries again.` };
  }
  return { ok: false, kind: "format", status: res.status, error: `Google Drive refused the request (${res.status}${reason ? ` ${reason}` : ""}).` };
}

const idOnly = z.object({ id: z.string().min(1) });
const fmt = (what: string): DriveFailure => ({ ok: false, kind: "format", error: `Google Drive answered ${what} in a format the console doesn't recognise.` });

function asId(r: DriveResult<unknown>, what: string): DriveResult<string> {
  if (!r.ok) return r;
  const p = idOnly.safeParse(r.data);
  return p.success ? { ok: true, data: p.data.id } : fmt(what);
}

// The folder the console made before, found by name among its own files (drive.file sees nothing else), else null.
export async function findFolder(token: string, name: string, opts: FetchOpts = {}): Promise<DriveResult<string | null>> {
  const q = `name = '${name.replace(/['\\]/g, "\\$&")}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const r = await call("GET", `${DRIVE}?${new URLSearchParams({ q, fields: "files(id,name)", spaces: "drive", pageSize: "10" })}`, token, null, opts);
  if (!r.ok) return r;
  const p = z.object({ files: z.array(idOnly) }).safeParse(r.data);
  return p.success ? { ok: true, data: p.data.files[0]?.id ?? null } : fmt("the folder search");
}

// A stored folder id is used only while the folder exists and isn't in the trash. `name` is its current name in
// Drive (whatever the owner calls it), so the console can show it.
export async function folderState(token: string, id: string, opts: FetchOpts = {}): Promise<DriveResult<{ usable: boolean; name: string | null }>> {
  const r = await call("GET", `${DRIVE}/${encodeURIComponent(id)}?fields=id,trashed,name`, token, null, opts);
  if (!r.ok) return r.kind === "missing" ? { ok: true, data: { usable: false, name: null } } : r;
  const p = z.object({ id: z.string(), trashed: z.boolean().optional(), name: z.string().optional() }).safeParse(r.data);
  return p.success ? { ok: true, data: { usable: !p.data.trashed, name: p.data.name?.trim() || null } } : fmt("the folder");
}

export async function folderUsable(token: string, id: string, opts: FetchOpts = {}): Promise<DriveResult<boolean>> {
  const r = await folderState(token, id, opts);
  return r.ok ? { ok: true, data: r.data.usable } : r;
}

export async function createFolder(token: string, name: string, opts: FetchOpts = {}): Promise<DriveResult<string>> {
  return asId(await call("POST", `${DRIVE}?fields=id`, token, { json: { name, mimeType: FOLDER_MIME } }, opts), "the new folder");
}

export async function createSpreadsheetFile(token: string, title: string, folderId: string, opts: FetchOpts = {}): Promise<DriveResult<string>> {
  return asId(await call("POST", `${DRIVE}?fields=id`, token, { json: { name: title, mimeType: SHEET_MIME, parents: [folderId] } }, opts), "the new spreadsheet");
}

const quote = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

// Makes the spreadsheet's tabs exactly the wanted names, in any order: the first existing tab is renamed when the first
// wanted one is missing (a new file starts with "Sheet1"), the others are added. Nothing is removed.
export async function ensureTabs(token: string, spreadsheetId: string, want: readonly string[], opts: FetchOpts = {}): Promise<DriveResult<void>> {
  const r = await call("GET", `${SHEETS}/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(sheetId,title)`, token, null, opts);
  if (!r.ok) return r;
  const p = z.object({ sheets: z.array(z.object({ properties: z.object({ sheetId: z.number(), title: z.string() }) })).default([]) }).safeParse(r.data);
  if (!p.success) return fmt("the spreadsheet's tabs");
  const have = p.data.sheets.map((s) => s.properties);
  const titles = new Set(have.map((h) => h.title));
  const requests: unknown[] = [];
  const missing = want.filter((t) => !titles.has(t));
  const first = have[0];
  if (first && missing.length && !want.includes(first.title)) {
    requests.push({ updateSheetProperties: { properties: { sheetId: first.sheetId, title: missing[0] }, fields: "title" } });
    missing.shift();
  }
  for (const title of missing) requests.push({ addSheet: { properties: { title } } });
  if (!requests.length) return { ok: true, data: undefined };
  const u = await call("POST", `${SHEETS}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, token, { json: { requests } }, opts);
  return u.ok ? { ok: true, data: undefined } : u;
}

export type Cell = string | number | boolean | null;
export type Tab = { title: string; rows: Cell[][] };

// Clears each tab, then writes every tab's rows from A1 in one values.batchUpdate (RAW: nothing is parsed as a formula).
export async function writeTabs(token: string, spreadsheetId: string, tabs: Tab[], opts: FetchOpts = {}): Promise<DriveResult<void>> {
  const id = encodeURIComponent(spreadsheetId);
  const clear = await call("POST", `${SHEETS}/${id}/values:batchClear`, token, { json: { ranges: tabs.map((t) => quote(t.title)) } }, opts);
  if (!clear.ok) return clear;
  const data = tabs.map((t) => ({ range: `${quote(t.title)}!A1`, majorDimension: "ROWS", values: t.rows.map((row) => row.map((c) => c ?? "")) }));
  const w = await call("POST", `${SHEETS}/${id}/values:batchUpdate`, token, { json: { valueInputOption: "RAW", data } }, opts);
  return w.ok ? { ok: true, data: undefined } : w;
}

const BOUNDARY = "watchbell-backup-part";

export function multipartBody(meta: Record<string, unknown>, content: Buffer, mimeType: string): Buffer {
  return Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${BOUNDARY}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${BOUNDARY}--`),
  ]);
}

// Multipart upload (spec §11). With `fileId` the same file's content is replaced (a retry or the full backup after a
// "Back up now"); a file that no longer exists is created again.
export async function uploadFile(
  token: string, f: { name: string; mimeType: string; folderId: string; content: Buffer; fileId?: string | null }, opts: FetchOpts = {},
): Promise<DriveResult<{ id: string; size: number }>> {
  const contentType = `multipart/related; boundary=${BOUNDARY}`;
  const parse = (r: DriveResult<unknown>): DriveResult<{ id: string; size: number }> => {
    if (!r.ok) return r;
    const p = z.object({ id: z.string().min(1), size: z.union([z.string(), z.number()]).optional() }).safeParse(r.data);
    return p.success ? { ok: true, data: { id: p.data.id, size: Number(p.data.size ?? f.content.length) || f.content.length } } : fmt("the upload");
  };
  if (f.fileId) {
    const raw = multipartBody({ name: f.name, mimeType: f.mimeType }, f.content, f.mimeType);
    const u = await call("PATCH", `${UPLOAD}/${encodeURIComponent(f.fileId)}?uploadType=multipart&fields=id,size`, token, { raw, contentType }, opts);
    if (u.ok || u.kind !== "missing") return parse(u);
  }
  const raw = multipartBody({ name: f.name, mimeType: f.mimeType, parents: [f.folderId] }, f.content, f.mimeType);
  return parse(await call("POST", `${UPLOAD}?uploadType=multipart&fields=id,size`, token, { raw, contentType }, opts));
}

// Retention (B5): to Drive's trash, which Drive empties for good after 30 days. A file that is already gone is fine.
export async function trashFile(token: string, id: string, opts: FetchOpts = {}): Promise<DriveResult<void>> {
  const r = await call("PATCH", `${DRIVE}/${encodeURIComponent(id)}?fields=id,trashed`, token, { json: { trashed: true } }, opts);
  return r.ok || r.kind === "missing" ? { ok: true, data: undefined } : r;
}
