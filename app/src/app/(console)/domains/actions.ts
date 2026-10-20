"use server";

import { refresh } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { updateTags } from "@/lib/cache/invalidate";
import { TAG } from "@/lib/cache/tags";
import { recordAction } from "@/lib/data/audit-db";
import { recheckDomain } from "@/lib/data/network-db";
import { isUuid } from "@/lib/ids";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

// Domains → Re-check (Operator and up): a TLS handshake and an RDAP read for one domain. Only console rows and an
// audit event change; nothing is written at Cloudflare or Vercel.
export async function recheck(domainId: string): Promise<ActionResult> {
  return runGuarded("operator", async (member): Promise<ActionResult> => {
    if (!isUuid(domainId)) return { ok: false, error: "Something in that request wasn't valid." };
    const quota = await limit(LIMITS.domainCheck, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many checks. Try again in ${minutesText(quota.retryAfter)}.` };
    const r = await recheckDomain(domainId);
    if (!r.ok) return r;
    // refresh() before updateTag: called after it, refresh() would downgrade the action to "dynamic only" and the
    // client would keep its prefetched segments (review m2). updateTag then marks static and dynamic as revalidated.
    refresh();
    updateTags([TAG.domains, TAG.zones]); // the certificate, the zone's RDAP and the derived states (perf P3)
    try {
      await recordAction({ kind: "ok", ...r.audit, actorUserId: member.userId });
    } catch {
      console.warn("audit event failed");
    }
    return { ok: true, message: r.message };
  }, { requireActionMember });
}
