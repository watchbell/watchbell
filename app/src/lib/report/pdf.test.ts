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

// Watchbell 1.7.1 (review M-3, M-4, M-5, M-6; owner's test T-2).
describe("renderReportPdf (1.7.1)", () => {
  it("page 1 explains the bad days and the time zone; incidents stay on page 2", async () => {
    const trace: string[] = [];
    await renderReportPdf(buildReportModel(input()), opts(), trace);
    const all = trace.join("\n");
    expect(all).toContain("Waktu dalam WIB");
    expect(all).toContain("23 Okt · Toko utama · tidak bisa dibuka total 22 menit");
    expect(trace.filter((s) => s.includes("tidak bisa dibuka selama 22 menit"))).toHaveLength(1);
    expect(all).toContain("tiap 1 menit");
  });

  it("the uptime box says when the data starts", async () => {
    const late = input();
    late.sites[0] = { ...late.sites[0], firstDay: "2026-10-12", days: new Map([...late.sites[0].days].filter(([d]) => d >= "2026-10-12")) };
    const trace: string[] = [];
    await renderReportPdf(buildReportModel(late), opts(), trace);
    expect(trace).toContain("data mulai 12 Okt 2026");
  });

  it("labels the chart's days and says when it leaves websites out", async () => {
    const trace: string[] = [];
    await renderReportPdf(buildReportModel(input(20)), opts({ lang: "en" }), trace);
    expect(trace).toContain("5 of 20 websites shown");
    for (const d of ["1", "8", "15", "22", "31"]) expect(trace.filter((s) => s === d).length).toBeGreaterThanOrEqual(2);
  });

  it("page 1 lists the days that couldn't be opened first, so the cap never hides them", async () => {
    const busy = input();
    busy.incidents = ["03", "05", "07", "11", "13", "15", "17"].map((d) => ({ monitorId: "https://kopisejahtera.id/m0", kind: "slow" as const, startedAt: new Date(`2026-10-${d}T03:00:00Z`), resolvedAt: new Date(`2026-10-${d}T03:20:00Z`), endedBy: "resolved" as const }));
    const trace: string[] = [];
    await renderReportPdf(buildReportModel(busy), opts(), trace);
    const i = trace.indexOf("23 Okt · Toko utama · tidak bisa dibuka total 22 menit");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(trace.indexOf("3 Okt · Toko utama · lambat"));
  });
});

// 1.8.3 (1.7.1 note): a long client name ran page 1's subtitle off the page, and the header's "For <client> · page 1
// of 2" (right-aligned) ran into the brand on the left. The subtitle wraps (two lines at most); the header shortens the
// name with "…".
describe("renderReportPdf with a long client name (1.8.3)", () => {
  const LONG = "PT Kopi Sejahtera Nusantara Raya Makmur Abadi Sentosa Jaya Bersama Indonesia Timur dan Barat Tbk";
  it("wraps page 1's subtitle instead of drawing it past the margin", async () => {
    const trace: string[] = [];
    await renderReportPdf(buildReportModel(input()), opts({ clientName: LONG }), trace);
    const sub = trace.filter((s) => s.startsWith("Untuk PT Kopi") || s.includes("Waktu dalam WIB"));
    expect(sub.some((s) => s.startsWith("Untuk PT Kopi") && s.includes("Waktu dalam WIB"))).toBe(false);
    expect(trace.join(" ")).toContain("Indonesia Timur dan Barat Tbk · 1 website · Waktu dalam WIB");
  });
  it("shortens the client name in the page header", async () => {
    const trace: string[] = [];
    await renderReportPdf(buildReportModel(input()), opts({ clientName: LONG }), trace);
    const head = trace.filter((s) => / · halaman [12] dari 2$/.test(s));
    expect(head).toHaveLength(2);
    for (const s of head) {
      expect(s).toContain("…");
      expect(s.length).toBeLessThan(60);
    }
  });
  it("keeps a short name whole", async () => {
    const trace: string[] = [];
    await renderReportPdf(buildReportModel(input()), opts(), trace);
    expect(trace).toContain("Untuk PT Kopi Sejahtera · halaman 1 dari 2");
  });
});

// Final review 1.8.3 minors. Fixed in 1.8.4: a 120-character title under the brand ran into the right-aligned line; one
// word longer than the line (a pasted link) was drawn past the margin. Pinned only: a realistic all-caps 120-character
// client name keeps the time zone on page 1 (it already did). A name of 120 wide letters (W…) still pushes it past the
// second line — deferred (final review 1.8.4 M1).
describe("renderReportPdf edge cases (1.8.4)", () => {
  it("shortens a 120-character title in the header, and keeps a short one whole", async () => {
    const title = "Laporan Bulanan Pemantauan Situs Web dan Layanan Daring untuk Seluruh Cabang Toko Kopi di Wilayah Jawa Barat dan Banten";
    expect(title.length).toBeGreaterThanOrEqual(115);
    const trace: string[] = [];
    await renderReportPdf(buildReportModel(input()), opts({ title }), trace);
    const drawn = trace.filter((s) => s.startsWith("Laporan Bulanan Pemantauan"));
    expect(drawn.length).toBeGreaterThanOrEqual(2);
    for (const s of drawn) {
      expect(s.endsWith("…")).toBe(true);
      expect(s.length).toBeLessThan(70);
    }
    const short: string[] = [];
    await renderReportPdf(buildReportModel(input()), opts({ title: "Laporan Oktober" }), short);
    expect(short.filter((s) => s === "Laporan Oktober").length).toBeGreaterThanOrEqual(2);
  });

  it("splits one word longer than the line instead of drawing it past the margin", async () => {
    const link = `https://kopisejahtera.id/${"promo-akhir-tahun-".repeat(12)}detail`;
    const trace: string[] = [];
    await renderReportPdf(buildReportModel(input()), opts({ note: `Lihat ${link} untuk detailnya.` }), trace);
    const pieces = trace.filter((s) => s.includes("promo-akhir-tahun-"));
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    for (const s of pieces) expect(s.length).toBeLessThan(link.length);
    expect(pieces.join("").replace(/^Lihat /, "")).toContain("promo-akhir-tahun-promo-akhir-tahun-");
  });

  it("keeps the time zone on page 1 under an all-caps 120-character client name", async () => {
    const name = "PT KOPI SEJAHTERA NUSANTARA RAYA MAKMUR ABADI SENTOSA JAYA BERSAMA INDONESIA TIMUR DAN BARAT TBK CABANG UTAMA WWWWWWWWWW".slice(0, 120);
    expect(name).toHaveLength(120);
    const trace: string[] = [];
    await renderReportPdf(buildReportModel(input()), opts({ clientName: name }), trace);
    expect(trace.join(" ")).toContain("Waktu dalam WIB");
    expect(trace.join(" ")).toContain("1 website");
  });
});
