"use server";

import { refresh } from "next/cache";
import { type ActionResult, type GuardMember, runGuarded } from "@/lib/action";
import { isRuleKey, parseRuleForm, RULES } from "@/lib/alerts/catalog";
import type { Notice } from "@/lib/alerts/compose";
import { requireActionMember } from "@/lib/auth";
import { type RuleTemplates, storedTemplate, TEMPLATE_LANGS, templateProblem } from "@/lib/alerts/message-template";
import { saveRule, saveRuleTemplates, silenceAlert } from "@/lib/data/alerts-db";
import { type Push, sendRuleTest } from "@/lib/data/notify-db";
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

// 1.2.4: the dialog's message texts, per language. Undefined when the form has none (Disable/Enable only switches the
// rule and leaves the texts alone); otherwise what to store, Watchbell's own wording and empty ones left out.
function parseTemplates(raw: unknown): { ok: true; value: RuleTemplates | undefined } | { ok: false; fieldErrors: Record<string, string> } {
  if (raw === undefined) return { ok: true, value: undefined };
  const value: RuleTemplates = {};
  const fieldErrors: Record<string, string> = {};
  for (const lang of TEMPLATE_LANGS) {
    const t = storedTemplate(raw && typeof raw === "object" ? (raw as Record<string, unknown>)[lang] : undefined, lang);
    const problem = t === null ? null : templateProblem(t);
    if (problem) fieldErrors[`template_${lang}`] = problem;
    else if (t !== null) value[lang] = t;
  }
  return Object.keys(fieldErrors).length ? { ok: false, fieldErrors } : { ok: true, value };
}

// Rules → Edit / Disable: Owners only (spec §10).
export async function editRule(key: string, form: { severity?: unknown; threshold?: unknown; channels?: unknown; enabled?: unknown; templates?: unknown }): Promise<ActionResult> {
  return runGuarded("owner", async (member) => {
    if (!isRuleKey(key)) return { ok: false, error: INVALID };
    const p = parseRuleForm(key, form);
    const t = parseTemplates(form?.templates);
    if (!p.ok || !t.ok) return { ok: false, error: "Check the highlighted fields.", fieldErrors: { ...(p.ok ? {} : p.fieldErrors), ...(t.ok ? {} : t.fieldErrors) } };
    const q = await quota(member);
    if (q) return q;
    if (!(await saveRule(key, p.value))) return { ok: false, error: "That rule isn't set up yet. Apply the alerts migration first." };
    if (t.value) await saveRuleTemplates(key, t.value);
    const wording = t.value === undefined ? "" : Object.keys(t.value).length ? " · custom message" : " · Watchbell's message";
    await recordAction({ kind: "ok", message: `Rule ${key} saved`, detail: `${RULES[key].condition(p.value.threshold)}${wording}`, resourceId: null, actorUserId: member.userId })
      .catch(() => console.warn("audit event failed"));
    refresh();
    return { ok: true, message: `${key}: ${RULES[key].condition(p.value.threshold)}.` };
  }, deps, "local");
}

const PUSH_NAME: Record<Push, string> = { telegram: "Telegram", discord: "Discord", webhook: "Webhook", smtp: "Email (SMTP)" };

// 1.2.4 (owner 26 Oct): Rules › Edit › Send test. The message as the dialog has it now (saved or not), sent as a made-up
// alert ("my-app", headed "Watchbell (tes)") to every ticked push channel; the daily digest isn't one. Owners only, the Send test limit.
export async function testRule(key: string, form: { severity?: unknown; threshold?: unknown; channels?: unknown; templates?: unknown }): Promise<ActionResult> {
  return runGuarded("owner", async (member) => {
    if (!isRuleKey(key)) return { ok: false, error: INVALID };
    const p = parseRuleForm(key, { ...form, enabled: true });
    const t = parseTemplates(form?.templates ?? {});
    if (!p.ok || !t.ok) return { ok: false, error: "Check the highlighted fields.", fieldErrors: { ...(p.ok ? {} : p.fieldErrors), ...(t.ok ? {} : t.fieldErrors) } };
    const kinds = (Object.keys(PUSH_NAME) as Push[]).filter((k) => p.value.channels.includes(k));
    if (!kinds.length) return { ok: false, error: "Tick Telegram, Discord, Webhook or Email (SMTP) first." };
    const q = await limit(LIMITS.notifyTest, member.id);
    if (!q.allowed) return { ok: false, error: `Too many tests. Try again in ${minutesText(q.retryAfter)}.` };
    const now = new Date();
    const notice: Notice = {
      kind: "open", ruleKey: key, severity: p.value.severity, title: "my-app", message: RULES[key].condition(p.value.threshold),
      startedAt: now, causedBy: null, provider: null, threshold: p.value.threshold,
    };
    const results = await sendRuleTest(kinds, notice, { [key]: t.value ?? {} }, now);
    const sent = results.filter((r) => r.result.ok).map((r) => PUSH_NAME[r.kind]);
    const failed = results.flatMap((r) => (r.result.ok ? [] : [`${PUSH_NAME[r.kind]}: ${r.result.error}`]));
    await recordAction({ kind: failed.length ? "err" : "ok", message: `Test of rule ${key} sent`, detail: [sent.length ? `to ${sent.join(", ")}` : "", ...failed].filter(Boolean).join(" · "), resourceId: null, actorUserId: member.userId })
      .catch(() => console.warn("audit event failed"));
    refresh();
    if (failed.length) return { ok: false, error: [...failed, sent.length ? `Sent to ${sent.join(", ")}.` : ""].filter(Boolean).join(" ") };
    return { ok: true, message: `Test sent to ${sent.join(", ")}.` };
  }, deps, "local");
}
