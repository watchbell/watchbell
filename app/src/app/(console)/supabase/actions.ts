"use server";

import { refresh } from "next/cache";
import { type ActionResult, type GuardMember, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { setFlag } from "@/lib/data/keep-active-db";
import type { Done } from "@/lib/data/monitors-db";
import { supabaseAct } from "@/lib/data/supabase-action";
import { isUuid } from "@/lib/ids";
import { INVALID } from "@/lib/provider-actions";
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
