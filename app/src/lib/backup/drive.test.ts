import { describe, expect, it } from "vitest";
import {
  createFolder, createSpreadsheetFile, downloadUrl, ensureTabs, findFolder, folderState, folderUsable, multipartBody, sheetUrl, trashFile, uploadFile, writeTabs,
} from "./drive";

type Seen = { url: string; method: string; headers: Record<string, string>; body: string };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// A fake fetch that answers in order and records every request (so tests pin method, URL and body).
function fake(...answers: Response[]) {
  const seen: Seen[] = [];
  const fn = async (url: string, init: RequestInit) => {
    const body = init.body instanceof Uint8Array ? Buffer.from(init.body).toString("latin1") : String(init.body ?? "");
    seen.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body });
    return answers.shift() ?? json({ error: { status: "UNEXPECTED" } }, 500);
  };
  return { fetch: fn as unknown as typeof fetch, seen };
}

describe("folder", () => {
  it("finds the console's own folder by name, never a trashed one", async () => {
    const f = fake(json({ files: [{ id: "fold1", name: "Watchbell backups" }] }));
    expect(await findFolder("tok", "Watchbell backups", f)).toEqual({ ok: true, data: "fold1" });
    const u = new URL(f.seen[0].url);
    expect(f.seen[0].method).toBe("GET");
    expect(u.searchParams.get("q")).toBe("name = 'Watchbell backups' and mimeType = 'application/vnd.google-apps.folder' and trashed = false");
    expect(f.seen[0].headers.Authorization).toBe("Bearer tok");
  });
  it("is null when there is none, and escapes quotes in the name", async () => {
    const f = fake(json({ files: [] }));
    expect(await findFolder("tok", "it's", f)).toEqual({ ok: true, data: null });
    expect(new URL(f.seen[0].url).searchParams.get("q")).toContain("name = 'it\\'s'");
  });
  it("creates a folder", async () => {
    const f = fake(json({ id: "fold2" }));
    expect(await createFolder("tok", "Watchbell backups", f)).toEqual({ ok: true, data: "fold2" });
    expect(f.seen[0]).toMatchObject({ method: "POST", url: "https://www.googleapis.com/drive/v3/files?fields=id" });
    expect(JSON.parse(f.seen[0].body)).toEqual({ name: "Watchbell backups", mimeType: "application/vnd.google-apps.folder" });
  });
  it("a stored folder is usable unless it is trashed or gone", async () => {
    expect(await folderUsable("tok", "a", fake(json({ id: "a", trashed: false })))).toEqual({ ok: true, data: true });
    expect(await folderUsable("tok", "a", fake(json({ id: "a", trashed: true })))).toEqual({ ok: true, data: false });
    expect(await folderUsable("tok", "a", fake(json({ error: {} }, 404)))).toEqual({ ok: true, data: false });
    expect(await folderUsable("tok", "a", fake(json({}, 503)))).toMatchObject({ ok: false, kind: "transient" });
  });
  it("reads the stored folder's current name with its state", async () => {
    const f = fake(json({ id: "a", trashed: false, name: "Watchpost backups" }));
    expect(await folderState("tok", "a", f)).toEqual({ ok: true, data: { usable: true, name: "Watchpost backups" } });
    expect(new URL(f.seen[0].url).searchParams.get("fields")).toBe("id,trashed,name");
    expect(await folderState("tok", "a", fake(json({ id: "a" })))).toEqual({ ok: true, data: { usable: true, name: null } });
    expect(await folderState("tok", "a", fake(json({ error: {} }, 404)))).toEqual({ ok: true, data: { usable: false, name: null } });
  });
});

describe("spreadsheet", () => {
  it("creates the file inside the folder", async () => {
    const f = fake(json({ id: "sheet1" }));
    expect(await createSpreadsheetFile("tok", "Watchbell · 2026-10", "fold1", f)).toEqual({ ok: true, data: "sheet1" });
    expect(JSON.parse(f.seen[0].body)).toEqual({ name: "Watchbell · 2026-10", mimeType: "application/vnd.google-apps.spreadsheet", parents: ["fold1"] });
  });
  it("renames Sheet1 to the first tab and adds the rest", async () => {
    const f = fake(json({ sheets: [{ properties: { sheetId: 0, title: "Sheet1" } }] }), json({}));
    expect(await ensureTabs("tok", "sheet1", ["Overview", "Applications", "Incidents"], f)).toEqual({ ok: true, data: undefined });
    expect(f.seen[1].url).toBe("https://sheets.googleapis.com/v4/spreadsheets/sheet1:batchUpdate");
    expect(JSON.parse(f.seen[1].body).requests).toEqual([
      { updateSheetProperties: { properties: { sheetId: 0, title: "Overview" }, fields: "title" } },
      { addSheet: { properties: { title: "Applications" } } },
      { addSheet: { properties: { title: "Incidents" } } },
    ]);
  });
  it("changes nothing when every tab is there (a retry)", async () => {
    const f = fake(json({ sheets: [{ properties: { sheetId: 0, title: "Overview" } }, { properties: { sheetId: 5, title: "Applications" } }] }));
    expect(await ensureTabs("tok", "s", ["Overview", "Applications"], f)).toEqual({ ok: true, data: undefined });
    expect(f.seen).toHaveLength(1);
  });
  it("clears, then writes every tab with RAW values from A1", async () => {
    const f = fake(json({}), json({}));
    const r = await writeTabs("tok", "s", [{ title: "Overview", rows: [["Month", "2026-10"], ["Apps", 3, null]] }, { title: "O'Brien", rows: [] }], f);
    expect(r).toEqual({ ok: true, data: undefined });
    expect(f.seen[0].url).toBe("https://sheets.googleapis.com/v4/spreadsheets/s/values:batchClear");
    expect(JSON.parse(f.seen[0].body)).toEqual({ ranges: ["'Overview'", "'O''Brien'"] });
    expect(JSON.parse(f.seen[1].body)).toEqual({
      valueInputOption: "RAW",
      data: [
        { range: "'Overview'!A1", majorDimension: "ROWS", values: [["Month", "2026-10"], ["Apps", 3, ""]] },
        { range: "'O''Brien'!A1", majorDimension: "ROWS", values: [] },
      ],
    });
  });
});

describe("upload", () => {
  const content = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
  it("creates a new file with a multipart/related body (metadata, then content)", async () => {
    const f = fake(json({ id: "csv1", size: "4" }));
    expect(await uploadFile("tok", { name: "watchbell-2026-10-raw.csv.gz", mimeType: "application/gzip", folderId: "fold1", content }, f)).toEqual({ ok: true, data: { id: "csv1", size: 4 } });
    expect(f.seen[0]).toMatchObject({ method: "POST", url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,size" });
    expect(f.seen[0].headers["Content-Type"]).toBe("multipart/related; boundary=watchbell-backup-part");
    expect(f.seen[0].body).toContain('{"name":"watchbell-2026-10-raw.csv.gz","mimeType":"application/gzip","parents":["fold1"]}');
  });
  it("replaces the content of the stored file, and creates it again when it is gone", async () => {
    const ok = fake(json({ id: "csv1", size: 4 }));
    expect(await uploadFile("tok", { name: "n", mimeType: "application/gzip", folderId: "f", content, fileId: "csv1" }, ok)).toMatchObject({ ok: true });
    expect(ok.seen[0]).toMatchObject({ method: "PATCH", url: "https://www.googleapis.com/upload/drive/v3/files/csv1?uploadType=multipart&fields=id,size" });
    expect(ok.seen[0].body).not.toContain("parents");
    const gone = fake(json({ error: {} }, 404), json({ id: "csv2" }));
    expect(await uploadFile("tok", { name: "n", mimeType: "application/gzip", folderId: "f", content, fileId: "csv1" }, gone)).toEqual({ ok: true, data: { id: "csv2", size: 4 } });
    expect(gone.seen.map((s) => s.method)).toEqual(["PATCH", "POST"]);
  });
  it("builds the multipart body byte for byte", () => {
    const b = multipartBody({ name: "x" }, Buffer.from("abc"), "text/plain").toString();
    expect(b).toBe('--watchbell-backup-part\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"x"}\r\n--watchbell-backup-part\r\nContent-Type: text/plain\r\n\r\nabc\r\n--watchbell-backup-part--');
  });
  it("says so when Drive is full, without retrying as a format error", async () => {
    const f = fake(json({ error: { errors: [{ reason: "storageQuotaExceeded" }] } }, 403));
    expect(await uploadFile("tok", { name: "n", mimeType: "m", folderId: "f", content }, f)).toMatchObject({ ok: false, kind: "full" });
  });
});

describe("retention writes", () => {
  it("moves a file to the trash with files.update, never DELETE", async () => {
    const f = fake(json({ id: "x", trashed: true }));
    expect(await trashFile("tok", "x", f)).toEqual({ ok: true, data: undefined });
    expect(f.seen[0]).toMatchObject({ method: "PATCH", url: "https://www.googleapis.com/drive/v3/files/x?fields=id,trashed" });
    expect(JSON.parse(f.seen[0].body)).toEqual({ trashed: true });
  });
  it("treats an already missing file as done", async () => {
    expect(await trashFile("tok", "x", fake(json({}, 404)))).toEqual({ ok: true, data: undefined });
  });
});

describe("never destroys (owner's rule)", () => {
  it("no request in this module is a DELETE or an emptyTrash", async () => {
    const all = fake(...Array.from({ length: 20 }, () => json({ id: "i", files: [], sheets: [] })));
    await findFolder("t", "n", all);
    await createFolder("t", "n", all);
    await createSpreadsheetFile("t", "n", "f", all);
    await ensureTabs("t", "s", ["A"], all);
    await writeTabs("t", "s", [{ title: "A", rows: [] }], all);
    await uploadFile("t", { name: "n", mimeType: "m", folderId: "f", content: Buffer.from("x"), fileId: "i" }, all);
    await trashFile("t", "i", all);
    expect(all.seen.length).toBeGreaterThan(6);
    for (const s of all.seen) {
      expect(s.method).not.toBe("DELETE");
      expect(s.url).not.toMatch(/emptyTrash|\/trash\b/);
    }
  });
  it("links point at Google's own pages", () => {
    expect(sheetUrl("abc")).toBe("https://docs.google.com/spreadsheets/d/abc/edit");
    expect(downloadUrl("a b")).toBe("https://drive.google.com/uc?export=download&id=a%20b");
  });
});
