// Turns observations into changes to ops.alerts (S2, S3, S4). Pure: the caller loads the open alerts and the rules,
// and writes the plan in one transaction.
import type { Severity } from "@/db/schema";
import { RULES, type RuleConfig, type RuleKey } from "./catalog";
import type { Observation } from "./evaluate";

export const RESOLVE_AFTER = 2;
export const REPEAT_MS = 6 * 3_600_000;
const MUTABLE_BY_DB: RuleKey[] = ["MonitorDown", "HighLatency"];

export type Pending = "open" | "repeat" | "resolve";
export type OpenAlert = {
  id: string; ruleKey: RuleKey; subject: string; okStreak: number; lastSampleAt: Date | null; silencedUntil: Date | null;
  silencedUntilResolved: boolean; notifiedOpen: boolean; lastNotifiedAt: Date | null; pending: Pending | null;
  // When the last notice was queued. A dropped open keeps it, so the retry waits REPEAT_MS from that attempt.
  pendingSince?: Date | null;
};
// collectorStale: CollectorStale fires. mutedApps: app id → "DatabasePaused · {db}". incidents: provider → label while
// its feed reports warn/err. maintenance: subjects and resource ids inside a maintenance window (filled by 5b).
export type PlanContext = { now: Date; collectorStale: boolean; mutedApps: Map<string, string>; incidents: Map<string, string>; maintenance: Set<string> };
export type NewAlert = {
  ruleKey: RuleKey; subject: string; resourceId: string | null; accountId: string | null; severity: Severity; title: string; message: string;
  startedAt: Date; lastSeenAt: Date; lastSampleAt: Date | null; causedBy: string | null; providerIncident: string | null; pending: Pending | null;
};
export type Touch = { id: string; okStreak: number; lastSampleAt: Date | null; lastSeenAt?: Date; message?: string; causedBy?: string | null; providerIncident?: string | null; pending?: Pending };
export type Resolve = { id: string; pending: "resolve" | null };
export type AlertPlan = { open: NewAlert[]; touch: Touch[]; resolve: Resolve[] };

const PUSH = ["telegram", "discord"];
const pushes = (r: RuleConfig) => r.channels.some((c) => PUSH.includes(c));

function muteReason(o: Observation, ctx: PlanContext): string | null {
  if (ctx.collectorStale && o.rule !== "CollectorStale") return "CollectorStale";
  if (o.resourceId && MUTABLE_BY_DB.includes(o.rule)) return ctx.mutedApps.get(o.resourceId) ?? null;
  return null;
}

// Stage 9 slice 5: an observation may raise the rule's DEFAULT severity (warning) to critical (VulnerableDependency's
// critical / RCE advisories). An owner's own choice (info, or critical already) is kept.
export const openSeverity = (rule: Severity, asked: "critical" | undefined): Severity => (asked === "critical" && rule === "warning" ? "critical" : rule);

const silenced = (a: OpenAlert, now: Date) => a.silencedUntilResolved || (a.silencedUntil !== null && a.silencedUntil.getTime() > now.getTime());
const key = (rule: string, subject: string) => `${rule}|${subject}`;

export function planAlerts(open: OpenAlert[], obs: Observation[], evaluated: Set<RuleKey>, rules: RuleConfig[], ctx: PlanContext): AlertPlan {
  const plan: AlertPlan = { open: [], touch: [], resolve: [] };
  const cfg = new Map(rules.map((r) => [r.key, r]));
  const byKey = new Map(obs.map((o) => [key(o.rule, o.subject), o]));
  const openKeys = new Set(open.map((a) => key(a.ruleKey, a.subject)));
  const resolveNow = (a: OpenAlert) => plan.resolve.push({ id: a.id, pending: a.notifiedOpen ? "resolve" : null });

  for (const a of open) {
    const rule = cfg.get(a.ruleKey);
    const o = byKey.get(key(a.ruleKey, a.subject));
    if (!rule || !rule.enabled) { plan.resolve.push({ id: a.id, pending: null }); continue; }
    if (!evaluated.has(a.ruleKey)) continue;
    if (!o) { plan.resolve.push({ id: a.id, pending: null }); continue; } // subject unwatched, gone or removed
    if (o.status === "unknown") continue;
    const incident = o.provider ? ctx.incidents.get(o.provider) ?? null : null;
    if (o.status === "firing") {
      const mute = muteReason(o, ctx);
      const due = a.notifiedOpen && a.lastNotifiedAt !== null && ctx.now.getTime() - a.lastNotifiedAt.getTime() >= REPEAT_MS;
      const t: Touch = { id: a.id, okStreak: 0, lastSampleAt: o.sampleAt ?? a.lastSampleAt, lastSeenAt: ctx.now, message: o.message, causedBy: mute, providerIncident: incident };
      // I1: an open that was never notified (it opened muted, or its notice was dropped) is sent once it can be, and a
      // dropped one is retried at most every REPEAT_MS. Otherwise such an alert would never page and never repeat.
      const openDue = !a.notifiedOpen && (!a.pendingSince || ctx.now.getTime() - a.pendingSince.getTime() >= REPEAT_MS);
      if ((due || openDue) && !silenced(a, ctx.now) && !mute && a.pending === null && pushes(rule)) t.pending = due ? "repeat" : "open";
      plan.touch.push(t);
      continue;
    }
    // ok
    if (!RULES[a.ruleKey].sampled || o.sampleAt === null) { resolveNow(a); continue; }
    const newer = a.lastSampleAt === null || o.sampleAt.getTime() > a.lastSampleAt.getTime();
    if (!newer) continue;
    const streak = a.okStreak + 1;
    if (streak >= RESOLVE_AFTER) resolveNow(a);
    else plan.touch.push({ id: a.id, okStreak: streak, lastSampleAt: o.sampleAt });
  }

  for (const o of obs) {
    if (o.status !== "firing" || openKeys.has(key(o.rule, o.subject))) continue;
    if (ctx.maintenance.has(o.subject) || (o.resourceId && ctx.maintenance.has(o.resourceId))) continue;
    const rule = cfg.get(o.rule);
    if (!rule) continue;
    const mute = muteReason(o, ctx);
    plan.open.push({
      ruleKey: o.rule, subject: o.subject, resourceId: o.resourceId, accountId: o.accountId, severity: openSeverity(rule.severity, o.severity), title: o.title, message: o.message,
      startedAt: ctx.now, lastSeenAt: ctx.now, lastSampleAt: o.sampleAt, causedBy: mute,
      providerIncident: o.provider ? ctx.incidents.get(o.provider) ?? null : null, pending: mute || !pushes(rule) ? null : "open",
    });
  }
  return plan;
}
