import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { DEFAULT_BRAND } from "@/lib/branding";
import type { DayCount } from "@/lib/view/uptime";
import { buildReportModel, type ReportInput } from "./model";
import { renderReportPdf } from "./pdf";

const OCT = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
const days = (fail: Record<string, number> = {}) => new Map<string, DayCount>(OCT.map((day) => [day, { day, checks: 1440, failures: fail[day] ?? 0, maint: 0 }]));
const site = (i: number, name: string, fail: Record<string, number> = {}) => ({
  // The monitor's address must never reach the PDF: the report only knows the display name.
  monitorId: `https://kopisejahtera.id/m${i}`, name, intervalS: 60, firstDay: "2026-10-01", days: days(fail), p50ByDay: new Map(OCT.map((d, j) => [d, 250 + ((i * 7 + j) % 40)])),
});
const input = (n = 1): ReportInput => ({
  month: "2026-10", zone: "Asia/Jakarta", generatedAt: new Date("2026-11-01T00:00:00Z"),
  sites: Array.from({ length: n }, (_, i) => site(i, i ? `Situs ${i}` : "Toko utama", i ? {} : { "2026-10-23": 22, "2026-10-09": 3 })),
  incidents: [{ monitorId: "https://kopisejahtera.id/m0", kind: "down", startedAt: new Date("2026-10-22T19:14:00Z"), resolvedAt: new Date("2026-10-22T19:36:00Z"), endedBy: "resolved" }],
  deploys: [{ monitorId: "https://kopisejahtera.id/m0", ok: 13, failed: 1, firstDay: "2026-10-01" }],
  dataFrom: { uptime: null, updates: null },
});
const brand = { ...DEFAULT_BRAND, name: "Studio Nusa", accent: "#0f766e" };
const opts = (over: Record<string, unknown> = {}) => ({
  brand, lang: "id" as const, zone: "Asia/Jakarta", clientName: "PT Kopi Sejahtera", title: null, note: "Gambar toko dipindah ke penyimpanan yang lebih cepat.", generatedAt: new Date("2026-11-01T00:00:00Z"), logo: null, ...over,
});

describe("renderReportPdf (1.7, design C)", () => {
  it("makes a two-page A4 PDF with the brand, the month, the client and the numbers", async () => {
    const trace: string[] = [];
    const bytes = await renderReportPdf(buildReportModel(input()), opts(), trace);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    expect(Math.round(doc.getPage(0).getWidth())).toBe(595);
    const all = trace.join("\n");
    for (const s of ["Studio Nusa", "Oktober 2026", "Laporan pemantauan website", "PT Kopi Sejahtera", "99,94%", "Toko utama", "Powered by Watchbell", "Gambar toko dipindah"]) expect(all).toContain(s);
    expect(all).toContain("tidak bisa dibuka selama 22 menit");
    expect(all).toContain("25 menit"); // the table's downtime is in the report's language too
    expect(all).not.toMatch(/\d min\b/);
    expect(all).not.toMatch(/kopisejahtera|https?:/);
  });

  it("writes English when asked, and leaves Powered by out when it is turned off", async () => {
    const trace: string[] = [];
    await renderReportPdf(buildReportModel(input()), opts({ lang: "en", brand: { ...brand, poweredBy: false } }), trace);
    const all = trace.join("\n");
    expect(all).toContain("October 2026");
    expect(all).toContain("Website monitoring report");
    expect(all).not.toContain("Powered by Watchbell");
  });

  it("draws a 10-site month in under a second", async () => {
    const before = process.memoryUsage().rss;
    const t0 = performance.now();
    const bytes = await renderReportPdf(buildReportModel(input(10)), opts());
    const ms = performance.now() - t0;
    expect(bytes.length).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(1000);
    expect((process.memoryUsage().rss - before) / 1024 / 1024).toBeLessThan(100);
  });
});

// Review I-6: a busy month must still fit two pages: long lists end with "and N more", nothing runs into the footer.
describe("renderReportPdf with a busy month", () => {
  it("fits 20 sites, 40 incidents and a long note on two pages", async () => {
    const big = input(20);
    big.incidents = Array.from({ length: 40 }, (_, i) => ({
      monitorId: big.sites[i % 20].monitorId, kind: i % 2 ? ("slow" as const) : ("down" as const),
      startedAt: new Date(Date.parse("2026-10-01T03:00:00Z") + i * 17 * 3_600_000), resolvedAt: new Date(Date.parse("2026-10-01T03:10:00Z") + i * 17 * 3_600_000), endedBy: "resolved" as const,
    }));
    const trace: string[] = [];
    const bytes = await renderReportPdf(buildReportModel(big), opts({ lang: "en", note: "A long note. ".repeat(80) }), trace);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
    const all = trace.join("\n");
    expect(all).toMatch(/and \d+ more/);
    expect(all).toContain("Powered by Watchbell"); // the footer is still drawn on both pages
  });
});
