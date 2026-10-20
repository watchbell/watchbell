"use server";

import { refresh } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { isUuid } from "@/lib/ids";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { setLimits } from "@/private/ui/deps";
import { parseLimits } from "./limits";

// R2: owner only. "Limits you enter" for one provider connection (the quota page's own counters run against them).
export async function saveLimits(providerId: string, raw: unknown): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    if (!isUuid(providerId)) return { ok: false, error: "Something in that request wasn't valid." };
    const parsed = parseLimits(raw);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const quota = await limit(LIMITS.credential, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many changes. Try again in ${minutesText(quota.retryAfter)}.` };
    const saved = await setLimits(providerId, parsed.value);
    if (!saved.ok) return { ok: false, error: saved.error };
    try {
      await recordAction({ kind: "ok", message: "AI provider limits changed", detail: `${parsed.value.length} limit${parsed.value.length === 1 ? "" : "s"}`, resourceId: null, actorUserId: member.userId });
    } catch {
      console.warn("audit event failed");
    }
    refresh();
    return { ok: true, message: "Limits saved." };
  }, { requireActionMember });
}
