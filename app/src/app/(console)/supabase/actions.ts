"use server";

import { refresh } from "next/cache";
import { type ActionResult, type GuardMember, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { setFlag } from "@/lib/data/keep-active-db";
import type { Done } from "@/lib/data/monitors-db";
import { loadTarget } from "@/lib/data/provider-action-db";
import { GONE, supabaseAct } from "@/lib/data/supabase-action";
import { servicesMessage } from "@/lib/databases/supabase";
import { isUuid } from "@/lib/ids";
import { cooldownText, INVALID, STALE } from "@/lib/provider-actions";
import { serviceHealth } from "@/lib/providers/supabase";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

// Stage 6 (A1–A6): Supabase Pause and Restore (Operator+, confirmed in a dialog) and the owner's Keep active /
// Auto-restore boxes (console rows only). Every export is a public endpoint, so each re-checks the role and every
// argument; the quota, the dialog's ref and the live status at Supabase are checked in supabaseAct before the one write.
const deps = { requireActionMember };
// Supabase project refs are 20 lowercase letters; anything else never reaches a URL.
const isRef = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9]{8,40}$/.test(v);

export async function pauseAction(resourceId: string, expectedRef: string): Promise<ActionResult> {
  return runGuarded("operator", async (member): Promise<ActionResult> => {
    if (!isUuid(resourceId) || !isRef(expectedRef)) return { ok: false, error: INVALID };
    return supabaseAct("pause", member, resourceId, expectedRef);
  }, deps);
}

export async function restoreAction(resourceId: string, expectedRef: string): Promise<ActionResult> {
  return runGuarded("operator", async (member): Promise<ActionResult> => {
    if (!isUuid(resourceId) || !isRef(expectedRef)) return { ok: false, error: INVALID };
    return supabaseAct("restore", member, resourceId, expectedRef);
  }, deps);
}

// 1.2.1 (4c): row menu → Check services. A read of the Management API's /health (the collector's hourly read), so no
// dialog and no audit; one check a minute per project.
export async function checkServicesAction(resourceId: string, expectedRef: string): Promise<ActionResult> {
  return runGuarded("operator", async (): Promise<ActionResult> => {
    if (!isUuid(resourceId) || !isRef(expectedRef)) return { ok: false, error: INVALID };
    const quota = await limit(LIMITS.actionTarget, `check-services:${resourceId}`);
    if (!quota.allowed) return { ok: false, error: cooldownText("target", quota.retryAfter) };
    const t = await loadTarget(resourceId, "supabase_project");
    if (!t) return { ok: false, error: GONE };
    if (t.resource.externalId !== expectedRef) return { ok: false, error: STALE };
    const r = await serviceHealth(t.token, t.resource.externalId);
    if (!r.ok) return { ok: false, error: `Couldn't read the service health at Supabase: ${r.error}` };
    const m = servicesMessage(r.data);
    return m.ok ? { ok: true, message: m.message } : { ok: false, error: m.message };
  }, deps);
}

// A8: console rows only (no dialog, no provider call). Owner only, with the console-row write quota.
async function saved(r: Done, member: GuardMember): Promise<ActionResult> {
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

function toggle(field: "keep" | "autoRestore", resourceId: string, on: boolean): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    if (!isUuid(resourceId) || typeof on !== "boolean") return { ok: false, error: INVALID };
    const quota = await limit(LIMITS.monitorWrite, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many changes. Try again in ${minutesText(quota.retryAfter)}.` };
    return saved(await setFlag(resourceId, field, on, member.userId), member);
  }, deps, "local");
}

export async function setKeepActive(resourceId: string, on: boolean): Promise<ActionResult> {
  return toggle("keep", resourceId, on);
}

export async function setAutoRestore(resourceId: string, on: boolean): Promise<ActionResult> {
  return toggle("autoRestore", resourceId, on);
}
