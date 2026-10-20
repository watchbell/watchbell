"use server";

import { refresh } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { dismiss, isUuid } from "./notes-view";

// Dismiss on an AI note (owner only, R2/R8): one row marked dismissed and an audit event (AiNoteDismissed).
export async function dismissNote(id: string): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    if (typeof id !== "string" || !isUuid(id)) return { ok: false, error: "Something in that request wasn't valid." };
    const quota = await limit(LIMITS.monitorWrite, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many changes. Try again in ${minutesText(quota.retryAfter)}.` };
    const done = await dismiss(id, member.userId, new Date());
    if (!done) return { ok: false, error: "That note was already dismissed." };
    try {
      await recordAction({
        kind: "ok", message: `AI note dismissed: ${done.title.slice(0, 120)}`, detail: `AiNoteDismissed · from ${done.from.slice(0, 60)}`,
        resourceId: done.appId && isUuid(done.appId) ? done.appId : null, actorUserId: member.userId,
      });
    } catch {
      console.warn("audit event failed");
    }
    refresh();
    return { ok: true, message: "Note dismissed." };
  }, { requireActionMember }, "local");
}
