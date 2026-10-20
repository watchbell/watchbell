"use server";

import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { ENDPOINT_ID, wakeAs } from "@/lib/data/neon-wake";
import { isUuid } from "@/lib/ids";
import { INVALID } from "@/lib/provider-actions";

// Stage 6 Neon Wake (plan A1): POST …/endpoints/{id}/start, the only Neon write. Operator or Owner, confirmed in the
// dialog, rate-limited per member and per target, read live first, audited (lib/data/neon-wake.ts). No restart: Neon's
// restart suspends first.
const deps = { requireActionMember };

export async function wakeAction(resourceId: string, endpointId: string): Promise<ActionResult> {
  return runGuarded("operator", async (member): Promise<ActionResult> => {
    if (!isUuid(resourceId) || typeof endpointId !== "string" || !ENDPOINT_ID.test(endpointId)) return { ok: false, error: INVALID };
    return wakeAs(member, resourceId, endpointId);
  }, deps);
}
