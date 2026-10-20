"use server";

import { refresh } from "next/cache";
import { db } from "@/db/client";
import { collectorRuns } from "@/db/schema";
import { type ActionResult, type GuardMember, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { runCollector } from "@/lib/collector/run";
import { recordAction } from "@/lib/data/audit-db";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

// Overview / Applications → "Refresh now": a manual collector run (spec §9.1). It holds the lease like any run, and
// skips monitors checked in the last 50 s (carry-over a), so pressing it twice can't mark a site down early.
// Spec §12: the request leaves an "action" event with the acting user (an error entry if the run failed).
export async function refreshNow(): Promise<ActionResult> {
  return runGuarded("operator", async (member): Promise<ActionResult> => {
    const limited = await refreshLimited(member);
    if (limited) return limited;
    // refresh() first: the run expires cached tags with revalidateTag, and a refresh() after that would downgrade the
    // action to "dynamic only" (review m2). A run that expires nothing still refreshes the page's dynamic data.
    refresh();
    const run = await runCollector("manual");
    await auditRefresh(member, run.skipped || run.ok);
    return {
      ok: true,
      message: run.skipped ? "A collector run is already going. New data arrives within a few seconds." : "Collector run requested. New data arrives within a few seconds.",
    };
  }, { requireActionMember }, simulatedRefresh);
}

// The refresh quota, shared by the real run and the demo's simulated one: the refusal to return, or null to go on.
async function refreshLimited(member: GuardMember): Promise<ActionResult | null> {
  const quota = await limit(LIMITS.refresh, member.id);
  return quota.allowed ? null : { ok: false, error: `Too many refreshes. Try again in ${minutesText(quota.retryAfter)}.` };
}

// The audit entry of a requested run (spec §12). A failed audit write is logged and doesn't undo the run.
async function auditRefresh(member: GuardMember, ok: boolean, detail?: string): Promise<void> {
  try {
    await recordAction({ kind: ok ? "ok" : "err", message: "Collector run requested", resourceId: null, actorUserId: member.userId, ...(detail ? { detail } : {}) });
  } catch {
    console.warn("audit event failed");
  }
}

// Demo: no collector may reach a provider, so the run is simulated: a finished manual run in the visitor's own database
// and the same audit entry, under the same quota. The made-up data itself stays as it is.
async function simulatedRefresh(member: GuardMember): Promise<ActionResult> {
  const limited = await refreshLimited(member);
  if (limited) return limited;
  const now = new Date();
  await db().insert(collectorRuns).values({ startedAt: new Date(now.getTime() - 900), finishedAt: now, trigger: "manual", tasks: [], ok: true, durationMs: 900, checks: 0 });
  await auditRefresh(member, true, "Simulated in the demo");
  refresh();
  return { ok: true, message: "Collector run simulated. The demo's data is made up, so nothing new arrives." };
}
