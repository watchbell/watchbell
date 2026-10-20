"use server";

import { refresh } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { updateTags } from "@/lib/cache/invalidate";
import { TAG } from "@/lib/cache/tags";
import { readAliasBook } from "@/lib/data/aliases-db";
import { saveLink } from "@/lib/data/databases-db";
import { isUuid } from "@/lib/ids";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { hideNames } from "@/lib/view/display-name";

const INVALID = "Something in that request wasn't valid.";

// App page → Database → Edit link (Operator and up). Changes console rows only (ops.links) plus an audit event.
export async function saveDatabaseLink(appId: string, dbId: string | null): Promise<ActionResult> {
  return runGuarded("operator", async (member): Promise<ActionResult> => {
    if (!isUuid(appId) || (dbId !== null && !isUuid(dbId))) return { ok: false, error: INVALID };
    const quota = await limit(LIMITS.monitorWrite, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many changes. Try again in ${minutesText(quota.retryAfter)}.` };
    const r = await saveLink(appId, dbId, member.userId);
    if (!r.ok) return r;
    // "Used by" on the database pages: the old and the new database can be of different providers (perf P3).
    refresh(); // before updateTag, which would otherwise be downgraded to "dynamic only" (review m2)
    updateTags([TAG.supabase, TAG.neon, TAG.firebase]);
    // Privacy: the toast names the database by its alias. The letters can't fail the saved link.
    const book = await readAliasBook().catch(() => null);
    return { ok: true, message: book ? hideNames(r.message, book, dbId) : "The database link is saved." };
  }, { requireActionMember }, "local");
}
