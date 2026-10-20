"use server";

import { refresh, revalidatePath } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { saveStatusPage } from "@/lib/data/public-status-db";
import { parseStatusPageForm } from "@/lib/public-status";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

// U6: what the public status page shows is the owner's choice alone (like the rest of Settings). The save shares the
// monitors' write limit, leaves an "action" event with the acting user, and refreshes the cached public page at once
// (the old address too when the slug changed, so it stops answering).
const deps = { requireActionMember };
const INVALID = "Something in that request wasn't valid.";

export async function saveStatusPageSettings(form: unknown): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    if (!form || typeof form !== "object") return { ok: false, error: INVALID };
    const p = parseStatusPageForm(form);
    if (!p.ok) return { ok: false, error: "Check the highlighted fields.", fieldErrors: p.fieldErrors };
    const quota = await limit(LIMITS.monitorWrite, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many changes. Try again in ${minutesText(quota.retryAfter)}.` };
    const r = await saveStatusPage(p.value);
    if (!r.ok) return { ok: false, error: r.error };
    try {
      await recordAction({ kind: "ok", ...r.audit, actorUserId: member.userId });
    } catch {
      console.warn("audit event failed");
    }
    revalidatePath(`/s/${p.value.slug}`);
    if (r.oldSlug) revalidatePath(`/s/${r.oldSlug}`);
    refresh();
    return { ok: true, message: r.message };
  }, deps, "local");
}
