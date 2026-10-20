import type { LogRow } from "@/private/ai/views-db";
import { modelOrTool, windowDateTime } from "./view";

// CSV of the Logs page: the same columns as the table, metadata only (R5). Cells that start like a spreadsheet formula
// get a leading apostrophe, so a hostile client name can't run in the owner's spreadsheet.
export const LOG_CSV_HEADER = ["Time (WIB)", "Key", "Client", "Model / tool", "Tokens in", "Tokens out", "Latency ms", "Status", "Stream", "Error class"];

export function csvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function logsToCsv(rows: LogRow[]): string {
  const lines = rows.map((r) => [
    windowDateTime(r.at), r.keyName, r.client, modelOrTool(r), r.tokensIn, r.tokensOut, r.latencyMs, r.status, r.stream ? "yes" : "no", r.errorClass,
  ].map(csvCell).join(","));
  return [LOG_CSV_HEADER.join(","), ...lines].join("\r\n") + "\r\n";
}
