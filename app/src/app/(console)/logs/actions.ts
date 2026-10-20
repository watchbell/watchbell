"use server";

import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { liveLogs } from "@/lib/data/logs-db";
import { isUuid } from "@/lib/ids";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { toWire, type WireLine } from "@/lib/view/logs";

// Logs → Last hour (S6): Operators and Owners; 60 reads per member per 10 minutes (auto-refresh every 15 s fits).
export async function readLastHour(appId: string | null): Promise<ActionResult<{ lines: WireLine[]; readAt: string; problems: string[] }>> {
  return runGuarded("operator", async (member) => {
    if (appId !== null && !isUuid(appId)) return { ok: false, error: "Something in that request wasn't valid." };
    const quota = await limit(LIMITS.logsLive, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many reads. Try again in ${minutesText(quota.retryAfter)}.` };
    const r = await liveLogs(new Date(), appId);
    return { ok: true, data: { lines: r.lines.map(toWire), readAt: r.readAt.toISOString(), problems: r.problems } };
  }, { requireActionMember });
}
