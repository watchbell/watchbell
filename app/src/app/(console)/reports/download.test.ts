import { describe, expect, it } from "vitest";
import { fetchReportPdf, fileNameFrom } from "./download";

// Review M-8 (1.7.1): Download PDF fetches in the page, so a refused download shows its reason instead of a failed file.
describe("fetchReportPdf", () => {
  it("gives the server's reason when the download is refused", async () => {
    const f = async () => new Response("Too many downloads. Try again in 9 minutes.", { status: 429 });
    expect(await fetchReportPdf("/reports/x/pdf?month=2026-10", f as typeof fetch)).toEqual({ ok: false, error: "Too many downloads. Try again in 9 minutes." });
  });

  it("gives the PDF and its file name", async () => {
    const f = async () => new Response(new Uint8Array([0x25, 0x50]), { status: 200, headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="kopi-senja-2026-10.pdf"' } });
    const r = await fetchReportPdf("/reports/x/pdf?month=2026-10", f as typeof fetch);
    expect(r.ok && r.filename).toBe("kopi-senja-2026-10.pdf");
    expect(r.ok && r.blob.size).toBe(2);
  });

  it("says so when the server can't be reached", async () => {
    const f = async () => { throw new TypeError("Failed to fetch"); };
    expect(await fetchReportPdf("/x", f as typeof fetch)).toEqual({ ok: false, error: "The download didn't reach the server. Check your connection and try again." });
  });

  it("never shows an HTML error page as the reason", async () => {
    const f = async () => new Response("<!doctype html><html>…</html>", { status: 500, headers: { "content-type": "text/html" } });
    expect(await fetchReportPdf("/x", f as typeof fetch)).toEqual({ ok: false, error: "The download failed (500). Try again in a moment." });
  });
});

describe("fileNameFrom", () => {
  it("reads the file name, or falls back", () => {
    expect(fileNameFrom('attachment; filename="a-2026-10.pdf"', "report.pdf")).toBe("a-2026-10.pdf");
    expect(fileNameFrom(null, "report.pdf")).toBe("report.pdf");
  });
});
