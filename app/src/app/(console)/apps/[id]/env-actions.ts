"use server";

import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { checkAppEnv } from "@/lib/data/env-check-db";
import { DEMO_ENV_CHECK, type EnvCheck } from "@/lib/env-check/check";
import { isUuid } from "@/lib/ids";
import { INVALID } from "@/lib/provider-actions";

// Watchbell 1.3: App page → Environment → Check now. Operator+, like View build logs; a read, so no quota and no audit.
// Demo: made-up findings, no provider call.
export async function envCheckAction(appId: string): Promise<ActionResult<EnvCheck>> {
  return runGuarded<EnvCheck>("operator", async () => {
    if (!isUuid(appId)) return { ok: false, error: INVALID };
    const r = await checkAppEnv(appId);
    return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error };
  }, { requireActionMember }, async () => ({ ok: true, data: { ...DEMO_ENV_CHECK, checkedAt: new Date().toISOString() } }));
}
