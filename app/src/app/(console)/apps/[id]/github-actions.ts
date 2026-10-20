"use server";

import { refresh } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { linkAppRepo, refreshAppActions } from "@/lib/data/github-db";
import { isUuid } from "@/lib/ids";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { actionsStatus } from "@/lib/view/github";

const deps = { requireActionMember };
const INVALID = "Something in that request wasn't valid.";

// B7: the owner confirms a suggested repository, picks another, or unlinks. Console rows only; audited.
export async function linkRepo(appId: string, repoId: string | null): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    if (!isUuid(appId) || (repoId !== null && !isUuid(repoId))) return { ok: false, error: INVALID };
    const r = await linkAppRepo(appId, repoId, member.userId);
    if (!r.ok) return r;
    await recordAction({
      kind: "ok", message: r.repo ? `Repository linked · ${r.app} → ${r.repo}` : `Repository unlinked · ${r.app}`, resourceId: appId, actorUserId: member.userId,
    }).catch(() => console.warn("repo link audit failed"));
    refresh();
    return { ok: true, message: r.message };
  }, deps, "local");
}

// B7: read the linked repository's latest Actions run now (a GitHub GET). Operator and up, 10 per member per 10 min.
export async function refreshRepoActions(appId: string): Promise<ActionResult> {
  return runGuarded("operator", async (member): Promise<ActionResult> => {
    if (!isUuid(appId)) return { ok: false, error: INVALID };
    const quota = await limit(LIMITS.githubRefresh, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many refreshes. Try again in ${minutesText(quota.retryAfter)}.` };
    const r = await refreshAppActions(appId);
    if (!r.ok) return r;
    refresh();
    const s = actionsStatus(r.run, null);
    return { ok: true, message: `GitHub Actions: ${s.label.toLowerCase()}.` };
  }, deps);
}
