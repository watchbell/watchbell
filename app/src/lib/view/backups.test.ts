import { describe, expect, it } from "vitest";
import { backupRows, driveState, sizeText } from "./backups";

describe("driveState", () => {
  it("says when the env is missing before anything else", () => {
    expect(driveState(false, { status: "ok", lastError: null })).toEqual({ kind: "env" });
  });
  it("tells not connected, connected, reconnect (invalid_grant) and a plain problem apart", () => {
    expect(driveState(true, null)).toEqual({ kind: "none" });
    expect(driveState(true, { status: "ok", lastError: null })).toEqual({ kind: "ok" });
    expect(driveState(true, { status: "error", lastError: "invalid_grant: Google Drive access was removed or has expired. Reconnect Google Drive." }).kind).toBe("reconnect");
    expect(driveState(true, { status: "error", lastError: "The stored Google Drive token can't be read (the encryption key changed). Reconnect Google Drive." }).kind).toBe("reconnect");
    expect(driveState(true, { status: "error", lastError: "Google returned an error (503)." })).toEqual({ kind: "problem", error: "Google returned an error (503)." });
  });
});

describe("backupRows", () => {
  const base = { sizeBytes: 188_416, error: null, sheetFileId: "sh", csvFileId: "cv", trashedAt: null };
  it("lists months newest first with links to Google's own pages", () => {
    const rows = backupRows([
      { ...base, month: "2026-08", status: "ok", finishedAt: new Date("2026-08-31T20:30:00Z") },
      { ...base, month: "2026-09", status: "ok", finishedAt: new Date("2026-09-30T20:30:00Z") },
    ]);
    expect(rows.map((r) => r.label)).toEqual(["September 2026", "August 2026"]);
    expect(rows[0]).toMatchObject({ state: "ok", status: "Saved", size: "184 KB", created: "1 Oct 03:30", sheet: "https://docs.google.com/spreadsheets/d/sh/edit", download: "https://drive.google.com/uc?export=download&id=cv" });
  });
  it("shows trashed months with the restore window and no links", () => {
    const [r] = backupRows([{ ...base, month: "2026-06", status: "ok", finishedAt: new Date("2026-06-30T20:30:00Z"), trashedAt: new Date("2026-09-30T20:31:00Z") }]);
    expect(r).toMatchObject({ state: "off", status: "Moved to Drive trash on 1 Oct", note: "Restorable from Drive trash until 31 Oct", sheet: null, csv: null });
  });
  it("shows a partial and a failed month", () => {
    const [p, f] = backupRows([
      { ...base, month: "2026-10", status: "partial", finishedAt: new Date("2026-10-15T03:00:00Z") },
      { ...base, month: "2026-09", status: "error", finishedAt: null, csvFileId: null, error: "Your Google Drive is full." },
    ]);
    expect(p).toMatchObject({ state: "info", status: "Month so far (Back up now)", note: "The full month is written on the 1st." });
    expect(f).toMatchObject({ state: "err", status: "Failed", note: "Your Google Drive is full.", created: "—", csv: null, sheet: "https://docs.google.com/spreadsheets/d/sh/edit" });
  });
  it("writes sizes like the mockup", () => {
    expect(sizeText(null)).toBe("—");
    expect(sizeText(900)).toBe("900 B");
    expect(sizeText(3_500_000)).toBe("3.3 MB");
  });
});
