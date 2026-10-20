"use server";

import { refresh } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { USAGE_COPY } from "@/lib/copy/edition";
import { recordAction } from "@/lib/data/audit-db";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { type AgLimits, EMPTY_LIMITS, LIMIT_FIELDS, parseLimitInput } from "@/private/ai/agent-usage";
import { saveLimits } from "@/private/ai/agent-usage-db";

// AI › Usage, "Antigravity quota (estimate)": the owner's own numbers for Google's limits (ops.settings
// antigravity.limits). Owner only (R2), counts against monitor-write (60 / 10 min), audited.
export async function saveAgLimits(form: FormData): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    const next: AgLimits = { ...EMPTY_LIMITS };
    for (const f of LIMIT_FIELDS) {
      const v = parseLimitInput(form.get(f.key));
      if (!v.ok) return { ok: false, error: `${f.label}: enter a whole number of tokens, or leave it blank.` };
      next[f.key] = v.value;
    }
    const q = await limit(LIMITS.monitorWrite, member.id);
    if (!q.allowed) return { ok: false, error: `Too many changes. Try again in ${minutesText(q.retryAfter)}.` };
    await saveLimits(next, new Date());
    try {
      await recordAction({ kind: "ok", message: USAGE_COPY.limitsAudit, resourceId: null, actorUserId: member.userId });
    } catch {
      console.warn("audit event failed");
    }
    refresh();
    return { ok: true, message: "Quota estimates saved." };
  }, { requireActionMember });
}
