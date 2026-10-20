"use server";

import { refresh } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { checkSecurityNow } from "@/lib/data/security-db";
import { isUuid } from "@/lib/ids";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

// App page → Security → Check now (Operator and up). Reads the app's live site and asks OSV.dev; only the console's
// own ops.app_security row and an audit event change.
export async function checkSecurity(appId: string): Promise<ActionResult<{ passed: boolean; vulnerable: boolean }>> {
  return runGuarded("operator", async (member): Promise<ActionResult<{ passed: boolean; vulnerable: boolean }>> => {
    if (!isUuid(appId)) return { ok: false, error: "Something in that request wasn't valid." };
    const quota = await limit(LIMITS.securityCheck, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many security checks. Try again in ${minutesText(quota.retryAfter)}.` };
    const r = await checkSecurityNow(appId);
    if (!r.ok) return { ok: false, error: r.error };
    try {
      await recordAction({ kind: r.passed ? "ok" : "err", ...r.audit, actorUserId: member.userId });
    } catch {
      console.warn("audit event failed");
    }
    refresh();
    return { ok: true, message: r.message, data: { passed: r.passed, vulnerable: r.vulnerable } };
  }, { requireActionMember });
}
