"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { syncGithub } from "@/lib/data/github-db";
import { isUuid } from "@/lib/ids";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

const deps = { requireActionMember };
// GitHub's Sync lists repositories, reads package.json names and the linked repositories' Actions status; it starts no
// new call after 20 s (the page's server actions get 60 s on Hobby).
const SYNC_MS = 20_000;

export async function syncGithubNow(accountId: string): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    if (typeof accountId !== "string" || !isUuid(accountId)) return { ok: false, error: "Something in that request wasn't valid." };
    const quota = await limit(LIMITS.sync, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many syncs. Try again in ${minutesText(quota.retryAfter)}.` };
    const r = await syncGithub(accountId, Date.now() + SYNC_MS);
    revalidatePath("/connections");
    revalidatePath("/apps", "layout");
    if (!r.ok) return { ok: false, error: r.error };
    const linked = r.newLinks ? ` · ${r.newLinks} app${r.newLinks === 1 ? "" : "s"} linked from Vercel` : "";
    return { ok: true, message: [`Found ${r.repos} repositor${r.repos === 1 ? "y" : "ies"}${linked}.`, ...r.notes].join(" ") };
  }, deps);
}
