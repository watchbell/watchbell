"use server";

import { refresh } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { dismiss } from "@/lib/data/advisor-db";
import { recordAction } from "@/lib/data/audit-db";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

// R3: Dismiss on a recommendation (Operator and up). One console row (ops.recommendation_dismissals) and an audit event.
// The item comes back 30 days later if it still applies.
export async function dismissRecommendation(key: string): Promise<ActionResult> {
  return runGuarded("operator", async (member): Promise<ActionResult> => {
    if (typeof key !== "string" || key.length === 0 || key.length > 200) return { ok: false, error: "Something in that request wasn't valid." };
    const quota = await limit(LIMITS.monitorWrite, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many changes. Try again in ${minutesText(quota.retryAfter)}.` };
    const r = await dismiss(key, member.userId, new Date());
    if (!r.ok) return { ok: false, error: r.error };
    try {
      await recordAction({ kind: "ok", message: `Recommendation dismissed: ${r.title}`, resourceId: r.appId, actorUserId: member.userId });
    } catch {
      console.warn("audit event failed");
    }
    refresh();
    return { ok: true, message: "Dismissed. It comes back in 30 days if it still applies." };
  }, { requireActionMember }, "local");
}
