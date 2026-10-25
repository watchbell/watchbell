"use server";

import { refresh } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { firestoreCheckNow } from "@/lib/collector/db-tasks";
import { pausedSections } from "@/lib/data/sections-db";
import { isUuid } from "@/lib/ids";
import { cooldownText, INVALID } from "@/lib/provider-actions";
import { LIMITS } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

const deps = { requireActionMember };

// 1.2.1 (4c): Firebase → row menu → Run health check. The collector's 5-minute Firestore read for this project, now
// (one document read of the 50k a day); it updates the Health column. Operator+, one check a minute per project.
export async function runHealthCheckAction(resourceId: string): Promise<ActionResult> {
  return runGuarded("operator", async (): Promise<ActionResult> => {
    if (!isUuid(resourceId)) return { ok: false, error: INVALID };
    // It writes the state and its event, which the Database switch holds while the section is off.
    if ((await pausedSections()).has("database")) return { ok: false, error: "Database is turned off (Manage › Sections)." };
    const quota = await limit(LIMITS.actionTarget, `health-check:${resourceId}`);
    if (!quota.allowed) return { ok: false, error: cooldownText("target", quota.retryAfter) };
    const r = await firestoreCheckNow(resourceId);
    if (!r.ok) return { ok: false, error: r.error };
    refresh();
    return r.state === "ok" ? { ok: true, message: r.label } : { ok: false, error: r.label };
  }, deps);
}
