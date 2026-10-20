"use server";

import { refresh } from "next/cache";
import { type ActionResult, type GuardMember, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import type { Done } from "@/lib/data/monitors-db";
import { removeMetricsKey, saveMetricsKey } from "@/lib/data/supabase-metrics-db";
import { isUuid } from "@/lib/ids";
import { INVALID } from "@/lib/provider-actions";
import { isProjectRef, isSecretKey } from "@/lib/providers/supabase-metrics";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

// Stage 12: the owner's per-project metrics key (Supabase Secret API key for the Metrics API). Owner only, the
// console-row write quota, audited without the key. Every export is a public endpoint, so each re-checks the role and
// every argument. The key is never sent back: the page only learns whether a project has one.
const deps = { requireActionMember };
const KEY_FORMAT = "Paste a Secret API key: it starts with sb_secret_.";

async function done(r: Done, member: GuardMember): Promise<ActionResult> {
  if (!r.ok) return { ok: false, error: r.error };
  if (r.audit) {
    try {
      await recordAction({ kind: "ok", ...r.audit, actorUserId: member.userId });
    } catch {
      console.warn("audit event failed");
    }
  }
  refresh();
  return { ok: true, message: r.message };
}

async function quota(member: GuardMember): Promise<ActionResult | null> {
  const q = await limit(LIMITS.monitorWrite, member.id);
  return q.allowed ? null : { ok: false, error: `Too many changes. Try again in ${minutesText(q.retryAfter)}.` };
}

export async function setMetricsKey(resourceId: string, expectedRef: string, key: string): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    if (!isUuid(resourceId) || !isProjectRef(expectedRef) || typeof key !== "string") return { ok: false, error: INVALID };
    const trimmed = key.trim();
    if (!isSecretKey(trimmed)) return { ok: false, error: KEY_FORMAT, fieldErrors: { key: KEY_FORMAT } };
    const refused = await quota(member);
    if (refused) return refused;
    return done(await saveMetricsKey(resourceId, expectedRef, trimmed, member.userId), member);
  }, deps);
}

export async function deleteMetricsKey(resourceId: string): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    if (!isUuid(resourceId)) return { ok: false, error: INVALID };
    const refused = await quota(member);
    if (refused) return refused;
    return done(await removeMetricsKey(resourceId), member);
  }, deps);
}
