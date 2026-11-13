"use server";

import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { checkPullRequests } from "@/lib/data/pr-checks-db";
import { isUuid } from "@/lib/ids";
import { DEMO_PR_CHECKS, type PrChecks } from "@/lib/precheck/pr-checks";
import { INVALID } from "@/lib/provider-actions";

// Watchbell 1.4: App page → Pull requests → Check open pull requests. Operator+, like the Environment check; a read, so
// no quota and no audit. Demo: made-up pull requests, no provider call.
export async function prChecksAction(appId: string): Promise<ActionResult<PrChecks>> {
  return runGuarded<PrChecks>("operator", async () => {
    if (!isUuid(appId)) return { ok: false, error: INVALID };
    const r = await checkPullRequests(appId);
    return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error };
  }, { requireActionMember }, async () => ({ ok: true, data: { ...DEMO_PR_CHECKS, checkedAt: new Date().toISOString() } }));
}
