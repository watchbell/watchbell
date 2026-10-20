"use server";

import { refresh } from "next/cache";
import { type ActionResult, type GuardMember, runGuarded } from "@/lib/action";
import { isRuleKey, parseRuleForm, RULES } from "@/lib/alerts/catalog";
import { requireActionMember } from "@/lib/auth";
import { saveRule, silenceAlert } from "@/lib/data/alerts-db";
import { recordAction } from "@/lib/data/audit-db";
import { isUuid } from "@/lib/ids";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

const deps = { requireActionMember };
const INVALID = "Something in that request wasn't valid.";

async function quota(member: GuardMember): Promise<ActionResult | null> {
  const q = await limit(LIMITS.alertWrite, member.id);
  return q.allowed ? null : { ok: false, error: `Too many changes. Try again in ${minutesText(q.retryAfter)}.` };
}

// Spec §12: Silence is Owner or Operator, no confirmation, audited.
export async function silence(id: string, choice: "1h" | "resolved" | "off"): Promise<ActionResult> {
  return runGuarded("operator", async (member) => {
    if (!isUuid(id) || !["1h", "resolved", "off"].includes(choice)) return { ok: false, error: INVALID };
    const q = await quota(member);
    if (q) return q;
    const done = await silenceAlert(id, choice, member.userId, new Date());
    if (!done) return { ok: false, error: "That alert has already resolved." };
    const msg = choice === "off" ? "Alert unsilenced" : choice === "1h" ? "Alert silenced for 1 hour" : "Alert silenced until resolved";
    // M10: the audit entry names the alert (rule and title) and links its resource.
    await recordAction({ kind: "ok", message: msg, detail: `${done.ruleKey} · ${done.title}`, resourceId: done.resourceId, actorUserId: member.userId }).catch(() => console.warn("audit event failed"));
    refresh();
    return { ok: true, message: choice === "off" ? "Notifications for this alert are back on." : "No more notifications for this alert until then." };
  }, deps, "local");
}

// Rules → Edit / Disable: Owners only (spec §10).
export async function editRule(key: string, form: { severity?: unknown; threshold?: unknown; channels?: unknown; enabled?: unknown }): Promise<ActionResult> {
  return runGuarded("owner", async (member) => {
    if (!isRuleKey(key)) return { ok: false, error: INVALID };
    const p = parseRuleForm(key, form);
    if (!p.ok) return { ok: false, error: "Check the highlighted fields.", fieldErrors: p.fieldErrors };
    const q = await quota(member);
    if (q) return q;
    if (!(await saveRule(key, p.value))) return { ok: false, error: "That rule isn't set up yet. Apply the alerts migration first." };
    await recordAction({ kind: "ok", message: `Rule ${key} saved`, detail: RULES[key].condition(p.value.threshold), resourceId: null, actorUserId: member.userId })
      .catch(() => console.warn("audit event failed"));
    refresh();
    return { ok: true, message: `${key}: ${RULES[key].condition(p.value.threshold)}.` };
  }, deps, "local");
}
