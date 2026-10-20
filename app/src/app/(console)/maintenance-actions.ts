"use server";

import { refresh } from "next/cache";
import { type ActionResult, type GuardMember, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { createWindow, deleteWindow, updateWindow, type WindowDone } from "@/lib/data/maintenance-db";
import { isUuid } from "@/lib/ids";
import { ENDED, hasEnded, parseWindowForm, type WindowForm } from "@/lib/maintenance";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

// U5: maintenance windows change console rows only and need an Owner or Operator. They share the monitors' write
// limit (60 per member per 10 minutes) and leave an "action" event with the acting user.
const deps = { requireActionMember };
const INVALID = "Something in that request wasn't valid.";

async function result(r: WindowDone, member: GuardMember): Promise<ActionResult> {
  if (!r.ok) return { ok: false, error: r.error };
  try {
    await recordAction({ kind: "ok", ...r.audit, actorUserId: member.userId });
  } catch {
    console.warn("audit event failed");
  }
  refresh();
  return { ok: true, message: r.message };
}

async function writeQuota(member: GuardMember): Promise<ActionResult | null> {
  const quota = await limit(LIMITS.monitorWrite, member.id);
  return quota.allowed ? null : { ok: false, error: `Too many changes. Try again in ${minutesText(quota.retryAfter)}.` };
}

// The form, parsed; a one-off that has already ended is a field error on Starts (review M4).
function parse(form: WindowForm): ReturnType<typeof parseWindowForm> | null {
  if (!form || typeof form !== "object") return null;
  const p = parseWindowForm(form);
  return p.ok && hasEnded(p.value, new Date()) ? { ok: false, fieldErrors: { start: ENDED } } : p;
}

export async function addWindow(form: WindowForm): Promise<ActionResult> {
  return runGuarded("operator", async (member): Promise<ActionResult> => {
    const p = parse(form);
    if (!p) return { ok: false, error: INVALID };
    if (!p.ok) return { ok: false, error: "Check the highlighted fields.", fieldErrors: p.fieldErrors };
    return (await writeQuota(member)) ?? (await result(await createWindow(p.value, member.userId), member));
  }, deps, "local");
}

export async function editWindow(id: string, form: WindowForm): Promise<ActionResult> {
  return runGuarded("operator", async (member): Promise<ActionResult> => {
    const p = parse(form);
    if (!isUuid(id) || !p) return { ok: false, error: INVALID };
    if (!p.ok) return { ok: false, error: "Check the highlighted fields.", fieldErrors: p.fieldErrors };
    return (await writeQuota(member)) ?? (await result(await updateWindow(id, p.value), member));
  }, deps, "local");
}

export async function removeWindow(id: string): Promise<ActionResult> {
  return runGuarded("operator", async (member): Promise<ActionResult> => {
    if (!isUuid(id)) return { ok: false, error: INVALID };
    return (await writeQuota(member)) ?? (await result(await deleteWindow(id), member));
  }, deps, "local");
}
