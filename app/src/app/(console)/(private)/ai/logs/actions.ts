"use server";

import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { usageExport } from "@/private/ai/views-db";
import { logsToCsv } from "@/private/ui/csv";
import { parseLogParams, type SearchParams } from "./filter";

// R2: owner only. The CSV has the table's columns, metadata only (R5), up to 5,000 rows of the current filter.
// 10 exports per owner per 10 minutes.
export async function exportLogsCsv(params: SearchParams): Promise<ActionResult<{ csv: string; rows: number }>> {
  return runGuarded("owner", async (member): Promise<ActionResult<{ csv: string; rows: number }>> => {
    const quota = await limit(LIMITS.sync, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many exports. Try again in ${minutesText(quota.retryAfter)}.` };
    const { filter } = parseLogParams(params ?? {});
    const rows = await usageExport(filter);
    return { ok: true, message: `Exported ${rows.length} row${rows.length === 1 ? "" : "s"}.`, data: { csv: logsToCsv(rows), rows: rows.length } };
  }, { requireActionMember }, "local");
}
