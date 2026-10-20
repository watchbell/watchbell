import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_COPY } from "@/lib/copy/edition";
import { buildAliasBook } from "@/lib/view/display-name";

type Row = { month: string; status: string; attempts: number; trashedAt: Date | null; sheetFileId: string | null; csvFileId: string | null; error?: string | null; sizeBytes?: number | null; driveFolderId?: string | null };
const h = vi.hoisted(() => ({
  account: null as null | { id: string; status: "ok" | "error"; lastError: string | null; lastTestAt: Date | null; refreshToken: string | null },
  rows: new Map<string, Row>(),
  folder: null as string | null,
  folderName: null as string | null,
  marks: [] as unknown[],
}));

vi.mock("@/lib/data/backup-db", () => ({
  driveAccount: async () => h.account,
  markDrive: async (_id: string, change: unknown) => { h.marks.push(change); },
  getBackup: async (m: string) => h.rows.get(m) ?? null,
  saveBackup: async (m: string, patch: Partial<Row>) => {
    h.rows.set(m, { month: m, status: "error", attempts: 0, trashedAt: null, sheetFileId: null, csvFileId: null, ...(h.rows.get(m) ?? {}), ...patch });
  },
  listBackups: async () => [...h.rows.values()].sort((a, b) => b.month.localeCompare(a.month)),
  readFolder: async () => (h.folder ? { id: h.folder, name: h.folderName } : null),
  saveFolderId: async (id: string, name?: string | null) => { h.folder = id; h.folderName = name ?? null; },
  readBackupInput: async (month: string, partial: boolean, now: Date) => ({
    month, partial, generatedAt: now, book: buildAliasBook([]), apps: [], rollups: [], events: [], alerts: [], deployments: [], databases: [], domains: [],
  }),
}));

import { monthlyBackupStep, runBackup } from "./run";

type Call = { method: string; url: string; body: string };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// A fake Google: answers by method + URL, records every call. `fail` makes one route answer with an error.
function google(over: Partial<Record<string, () => Response>> = {}) {
  const calls: Call[] = [];
  let n = 0;
  const route = (method: string, url: string): string => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return "token";
    if (method === "GET" && url.includes("/drive/v3/files?")) return "findFolder";
    if (method === "GET" && url.includes("/drive/v3/files/")) return "folderUsable";
    if (method === "POST" && url === "https://www.googleapis.com/drive/v3/files?fields=id") return "create";
    if (method === "GET" && url.includes("sheets.googleapis.com")) return "tabs";
    if (url.endsWith("values:batchClear")) return "clear";
    if (url.endsWith("values:batchUpdate")) return "values";
    if (url.endsWith(":batchUpdate")) return "structure";
    if (url.includes("/upload/")) return "upload";
    if (method === "PATCH" && url.includes("/drive/v3/files/")) return "trash";
    return "unknown";
  };
  const fetch = async (url: string, init: RequestInit) => {
    const method = String(init.method ?? "GET");
    const body = init.body instanceof Uint8Array ? `<${init.body.length} bytes>` : String(init.body ?? "");
    calls.push({ method, url, body });
    const r = route(method, url);
    if (over[r]) return over[r]!();
    switch (r) {
      case "token": return json({ access_token: "ya29.fake" });
      case "findFolder": return json({ files: [] });
      case "folderUsable": return json({ id: "fold1", trashed: false });
      case "create": return json({ id: JSON.parse(body).mimeType.endsWith("folder") ? "fold1" : `sheet${++n}` });
      case "tabs": return json({ sheets: [{ properties: { sheetId: 0, title: "Sheet1" } }] });
      case "upload": return json({ id: "csv1", size: "321" });
      case "unknown": return json({ error: { status: "UNEXPECTED" } }, 500);
      default: return json({});
    }
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, routes: () => calls.map((c) => route(c.method, c.url)) };
}

const NOV_1 = new Date("2026-10-31T20:05:00Z"); // 1 Nov 2026, 03:05 WIB
const later = () => Date.now() + 60_000;

beforeEach(() => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "1234-fake.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "fake-client-secret");
  vi.stubEnv("OPS_ENCRYPTION_KEY", Buffer.alloc(32, 1).toString("base64"));
  h.account = { id: "acc-drive", status: "ok", lastError: null, lastTestAt: null, refreshToken: "fake-refresh-token" };
  h.rows.clear();
  h.folder = null;
  h.folderName = null;
  h.marks = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("runBackup", () => {
  it("makes the folder, the sheet with five tabs, the CSV, and records the month as ok", async () => {
    const g = google();
    const r = await runBackup({ month: "2026-10", partial: false, now: NOV_1, deadline: later(), fetch: g.fetch });
    expect(r).toEqual({ ok: true, month: "2026-10", message: "October 2026 saved to Google Drive.", retention: null });
    expect(g.routes()).toEqual(["token", "findFolder", "findFolder", "create", "create", "tabs", "structure", "clear", "values", "upload"]);
    expect(h.folder).toBe("fold1");
    const folderCreate = g.calls.find((c) => c.method === "POST" && c.url.includes("/drive/v3/files?fields=id") && JSON.parse(c.body).mimeType.endsWith("folder"));
    expect(JSON.parse(folderCreate!.body).name).toBe("Watchbell backups"); // only a brand-new connection gets the new name
    expect(h.folderName).toBe("Watchbell backups");
    expect(h.rows.get("2026-10")).toMatchObject({ status: "ok", sheetFileId: "sheet1", csvFileId: "csv1", sizeBytes: 321, error: null, attempts: 1 });
    const structure = JSON.parse(g.calls.find((c) => c.url.endsWith(":batchUpdate"))!.body);
    expect(structure.requests).toHaveLength(5);
    const sheet = JSON.parse(g.calls.find((c) => c.method === "POST" && c.body.includes("spreadsheet"))!.body);
    expect(sheet).toEqual({ name: "Watchbell · 2026-10", mimeType: "application/vnd.google-apps.spreadsheet", parents: ["fold1"] });
  });

  it("resumes from the stored ids: no second spreadsheet, the CSV's content replaced", async () => {
    h.folder = "fold1";
    h.rows.set("2026-10", { month: "2026-10", status: "error", attempts: 1, trashedAt: null, sheetFileId: "sheetA", csvFileId: "csvA" });
    const g = google({ tabs: () => json({ sheets: ["Overview", "Applications", "Incidents", "Databases", "Domains"].map((title, i) => ({ properties: { sheetId: i, title } })) }) });
    const r = await runBackup({ month: "2026-10", partial: false, now: NOV_1, deadline: later(), fetch: g.fetch });
    expect(r.ok).toBe(true);
    expect(g.routes()).toEqual(["token", "folderUsable", "tabs", "clear", "values", "upload"]);
    expect(g.calls.at(-1)).toMatchObject({ method: "PATCH" });
    expect(g.calls.at(-1)!.url).toContain("/upload/drive/v3/files/csvA?");
    expect(h.rows.get("2026-10")).toMatchObject({ status: "ok", sheetFileId: "sheetA", attempts: 2 });
  });

  it("a stored folder always wins: no search, no new folder, nothing renamed (the owner's Watchpost backups folder)", async () => {
    h.folder = "ownersFolder";
    h.folderName = null; // stored before folder names were recorded
    const g = google({ folderUsable: () => json({ id: "ownersFolder", trashed: false, name: "Watchpost backups" }) });
    const r = await runBackup({ month: "2026-10", partial: false, now: NOV_1, deadline: later(), fetch: g.fetch });
    expect(r.ok).toBe(true);
    expect(h.folder).toBe("ownersFolder");
    expect(h.folderName).toBe("Watchpost backups"); // its real name, recorded for the Backups page
    expect(g.routes()).not.toContain("findFolder");
    expect(g.calls.filter((c) => c.method === "POST" && c.body.includes("folder"))).toEqual([]);
    expect(g.calls.some((c) => c.method === "PATCH" && c.url.includes("/ownersFolder"))).toBe(false);
    expect(g.calls.some((c) => c.method === "POST" && c.body.includes("ownersFolder"))).toBe(true); // the new sheet goes into it
  });

  it("finds the folder by its name from before the rename when the stored id is lost, instead of making a second one", async () => {
    h.folder = null;
    let searches = 0;
    const g2 = google({ findFolder: () => json({ files: ++searches === 2 ? [{ id: "legacyFold" }] : [] }) });
    await runBackup({ month: "2026-10", partial: false, now: NOV_1, deadline: later(), fetch: g2.fetch });
    const queries = g2.calls.filter((c) => c.url.includes("/drive/v3/files?")).map((c) => new URL(c.url).searchParams.get("q"));
    expect(queries[0]).toContain("name = 'Watchbell backups'");
    expect(queries[1]).toContain("name = 'Watchpost backups'");
    expect(h.folder).toBe("legacyFold");
    expect(h.folderName).toBe("Watchpost backups");
    expect(g2.routes().filter((x) => x === "create")).toHaveLength(1); // only the spreadsheet
  });

  it("reuses the console's folder found by name when the stored one was trashed", async () => {
    h.folder = "old";
    const g = google({ folderUsable: () => json({ id: "old", trashed: true }), findFolder: () => json({ files: [{ id: "found" }] }) });
    await runBackup({ month: "2026-10", partial: false, now: NOV_1, deadline: later(), fetch: g.fetch });
    expect(h.folder).toBe("found");
    expect(g.routes().filter((x) => x === "create")).toHaveLength(1); // only the spreadsheet
  });

  it("invalid_grant marks the account for Reconnect and records the failed month", async () => {
    const g = google({ token: () => json({ error: "invalid_grant" }, 400) });
    const r = await runBackup({ month: "2026-10", partial: false, now: NOV_1, deadline: later(), fetch: g.fetch });
    expect(r).toMatchObject({ ok: false, kind: "revoked" });
    expect(h.marks).toEqual([{ status: "error", lastError: "invalid_grant: Google Drive access was removed or has expired. Reconnect Google Drive." }]);
    expect(h.rows.get("2026-10")).toMatchObject({ status: "error" });
    expect(g.routes()).toEqual(["token"]);
  });

  it("a working token clears an earlier error on the account", async () => {
    h.account = { ...h.account!, status: "error", lastError: "Google returned an error (503)." };
    await runBackup({ month: "2026-10", partial: false, now: NOV_1, deadline: later(), fetch: google().fetch });
    expect(h.marks).toEqual([{ status: "ok", lastError: null }]);
  });

  it("stops starting calls after the deadline and keeps what it made", async () => {
    let calls = 0;
    const g = google();
    const slow = (async (url: string, init: RequestInit) => {
      calls++;
      return g.fetch(url, init);
    }) as typeof fetch;
    const r = await runBackup({ month: "2026-10", partial: false, now: NOV_1, deadline: Date.now() - 1, fetch: slow });
    expect(r).toMatchObject({ ok: false, kind: "time" });
    expect(calls).toBe(1); // the token only
    expect(h.rows.get("2026-10")?.status).toBe("error");
  });

  it("a Drive failure is recorded and retried later, and its text never includes the token", async () => {
    const g = google({ upload: () => json({ error: { errors: [{ reason: "storageQuotaExceeded" }] } }, 403) });
    const r = await runBackup({ month: "2026-10", partial: false, now: NOV_1, deadline: later(), fetch: g.fetch });
    expect(r).toMatchObject({ ok: false, kind: "failed", error: "Your Google Drive is full. Free some space; the next run tries again." });
    expect(h.rows.get("2026-10")).toMatchObject({ status: "error", sheetFileId: "sheet1", csvFileId: null });
    expect(JSON.stringify([...h.rows.values()])).not.toContain("ya29");
  });

  it("Back up now writes the month so far as partial and trashes nothing", async () => {
    for (const m of ["2026-09", "2026-08", "2026-07", "2026-06"]) h.rows.set(m, { month: m, status: "ok", attempts: 1, trashedAt: null, sheetFileId: `s${m}`, csvFileId: `c${m}` });
    const g = google();
    const r = await runBackup({ month: "2026-10", partial: true, now: new Date("2026-10-15T03:00:00Z"), deadline: later(), fetch: g.fetch });
    expect(r).toMatchObject({ ok: true, message: "October 2026 so far saved to Google Drive.", retention: null });
    expect(h.rows.get("2026-10")?.status).toBe("partial");
    expect(g.routes()).not.toContain("trash");
  });

  it("after a full month, moves months beyond the newest three to Drive's trash", async () => {
    for (const m of ["2026-09", "2026-08", "2026-07"]) h.rows.set(m, { month: m, status: "ok", attempts: 1, trashedAt: null, sheetFileId: `s${m}`, csvFileId: `c${m}` });
    const g = google();
    const r = await runBackup({ month: "2026-10", partial: false, now: NOV_1, deadline: later(), fetch: g.fetch });
    expect(r).toMatchObject({ ok: true, retention: "Moved to Drive trash: July 2026." });
    const trashed = g.calls.filter((c) => c.method === "PATCH" && !c.url.includes("/upload/"));
    expect(trashed.map((c) => c.url)).toEqual([
      "https://www.googleapis.com/drive/v3/files/s2026-07?fields=id,trashed",
      "https://www.googleapis.com/drive/v3/files/c2026-07?fields=id,trashed",
    ]);
    expect(trashed.every((c) => JSON.parse(c.body).trashed === true)).toBe(true);
    expect(h.rows.get("2026-07")?.trashedAt).toEqual(NOV_1);
    expect(g.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("says what is missing without calling Google", async () => {
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    const g = google();
    expect(await runBackup({ month: "2026-10", partial: false, now: NOV_1, deadline: later(), fetch: g.fetch }))
      .toEqual({ ok: false, month: "2026-10", kind: "env", error: ENV_COPY.notSet("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET", true) });
    h.account = null;
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "fake-client-secret");
    expect(await runBackup({ month: "2026-10", partial: false, now: NOV_1, deadline: later(), fetch: g.fetch })).toMatchObject({ ok: false, kind: "not-connected" });
    expect(g.calls).toEqual([]);
  });
});

describe("monthlyBackupStep (the daily job)", () => {
  it("does nothing without Drive, with a revoked grant, or when nothing is due", async () => {
    const g = google();
    h.account = null;
    expect(await monthlyBackupStep(NOV_1, later(), { fetch: g.fetch })).toBeNull();
    h.account = { id: "a", status: "error", lastError: "invalid_grant: …", lastTestAt: null, refreshToken: "rt" };
    expect(await monthlyBackupStep(NOV_1, later(), { fetch: g.fetch })).toBeNull();
    h.account = { id: "a", status: "ok", lastError: null, lastTestAt: null, refreshToken: "rt" };
    h.rows.set("2026-10", { month: "2026-10", status: "ok", attempts: 1, trashedAt: null, sheetFileId: "s", csvFileId: "c" });
    expect(await monthlyBackupStep(NOV_1, later(), { fetch: g.fetch })).toBeNull();
    expect(g.calls).toEqual([]);
  });
  it("backs up the month that just ended on the 1st, and reports a failure in one line", async () => {
    expect(await monthlyBackupStep(NOV_1, later(), { fetch: google().fetch })).toBeNull();
    expect(h.rows.get("2026-10")?.status).toBe("ok");
    h.rows.clear();
    expect(await monthlyBackupStep(NOV_1, later(), { fetch: google({ token: () => json({}, 503) }).fetch }))
      .toBe("October 2026: Google returned an error (503). The next run tries again.");
  });
});
