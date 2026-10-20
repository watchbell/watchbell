"use server";

import { refresh } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { scanAppNow } from "@/lib/data/deps-db";
import { isUuid } from "@/lib/ids";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

// App page → Dependencies → Scan now (Operator and up, Stage 9 slice 5). Reads the linked repository's lockfile with the
// read-only GitHub token and asks OSV.dev; only the console's own rows (ops.dependency_*) and an audit event change.
export async function scanDependencies(appId: string): Promise<ActionResult<{ vulns: number }>> {
  return runGuarded("operator", async (member): Promise<ActionResult<{ vulns: number }>> => {
    if (!isUuid(appId)) return { ok: false, error: "Something in that request wasn't valid." };
    const quota = await limit(LIMITS.depsScan, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many dependency scans. Try again in ${minutesText(quota.retryAfter)}.` };
    const r = await scanAppNow(appId);
    if (!r.ok) return { ok: false, error: r.error };
    try {
      await recordAction({ kind: "ok", message: `Dependency scan · ${r.app} · ${r.vulns} open`, resourceId: appId, actorUserId: member.userId });
    } catch {
      console.warn("audit event failed");
    }
    refresh();
    return { ok: true, message: r.message, data: { vulns: r.vulns } };
  }, { requireActionMember });
}
