import "server-only";
import { readBrand, readBrandLogo } from "@/lib/data/branding-db";
import { getReport, type ReportRow, readReportInput } from "@/lib/data/report-db";
import type { ReportLang } from "./i18n";
import { buildReportModel } from "./model";
import { renderReportPdf } from "./pdf";

// Watchbell 1.7: one report and month as PDF bytes, for the download route and the monthly send alike.

// "PT Kopi Sejahtera" → "PT-Kopi-Sejahtera-2026-10.pdf" (ASCII only, so every mail client and browser keeps the name).
export const reportFileName = (client: string, month: string) =>
  `${client.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "report"}-${month}.pdf`;

export type MadeReport = { bytes: Uint8Array; filename: string; report: ReportRow };
export type MakeError = { error: "not-found" | "no-sites" | "month-too-old" | "render-failed" };

export async function makeReportPdf(id: string, month: string, now: Date, zone: string, lang?: ReportLang): Promise<MadeReport | MakeError> {
  const report = await getReport(id);
  if (!report) return { error: "not-found" };
  const input = await readReportInput(id, month, now, zone);
  if ("error" in input) return input;
  const [brand, logo] = await Promise.all([readBrand(), readBrandLogo()]);
  let bytes: Uint8Array;
  try {
    bytes = await renderReportPdf(buildReportModel(input), {
      brand, logo, lang: lang ?? report.lang, zone, clientName: report.clientName, title: report.title, note: report.note, generatedAt: now,
    });
  } catch (e) {
    // Review M-7 (1.7.1): said as such, never as "the report no longer exists". Only the error, never the recipients.
    console.error(`report PDF failed: ${e instanceof Error ? e.message : String(e)}`);
    return { error: "render-failed" };
  }
  return { bytes, filename: reportFileName(report.clientName, month), report };
}
