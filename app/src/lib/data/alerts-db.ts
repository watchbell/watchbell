import "server-only";
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, alertRules, alerts, providerStatus, resources, settings, snapshots } from "@/db/schema";
import { isRuleKey, RULE_KEYS, RULES, type RuleConfig, type RuleKey } from "@/lib/alerts/catalog";
import { evaluate } from "@/lib/alerts/evaluate";
import { type OpenAlert, type PlanContext, planAlerts } from "@/lib/alerts/lifecycle";
import { type MessageTemplates, parseTemplates, type RuleTemplates, TEMPLATES_KEY } from "@/lib/alerts/message-template";
import { maintenanceSet } from "@/lib/maintenance";
import { alertPaused, type SectionId } from "@/lib/sections";
import { silenceUntil } from "@/lib/view/alerts";
import { loadFacts } from "./alert-facts-db";
import { listRawWindows } from "./maintenance-db";
import { activeAlertFilter, pausedSections } from "./sections-db";

export const FEED_LABEL: Record<string, string> = { vercel: "Vercel", supabase: "Supabase", neon: "Neon", cloudflare: "Cloudflare", firebase: "Firebase", gcp: "Google Cloud" };

export async function loadRules(): Promise<RuleConfig[]> {
  const rows = await db().select().from(alertRules);
  return rows.filter((r) => isRuleKey(r.key)).map((r) => ({ key: r.key as RuleKey, severity: r.severity, threshold: r.threshold, enabled: r.enabled, channels: r.channels }));
}

// One evaluation: load facts, rules and open alerts, plan, write. The writes run in one transaction; the partial unique
// index makes a concurrent duplicate open fail instead of doubling (the watchdog and the collector can overlap).
// Watchbell 1.2 (D11): the subjects of a section the owner turned off are left out on both sides (no observation, no
// open alert), so nothing of theirs opens, repeats or resolves; their open alerts stay exactly as they were.
export async function evaluateAlerts(now: Date, opts: { only?: RuleKey[] } = {}): Promise<{ opened: number; resolved: number }> {
  const [facts, rules, openAll, feeds, windows, paused] = await Promise.all([
    loadFacts(now), loadRules(),
    db().select().from(alerts).where(isNull(alerts.resolvedAt)),
    db().select({ provider: providerStatus.provider, state: providerStatus.state }).from(providerStatus),
    listRawWindows(),
    pausedSections(),
  ]);
  const accountProvider = new Map(facts.accounts.map((a) => [a.id, a.provider as string]));
  const openRows = openAll.filter((a) => !alertPaused(paused, a.ruleKey, a.accountId ? accountProvider.get(a.accountId) : null));
  const all = evaluate(facts, rules, opts.only);
  const evaluated = all.evaluated;
  const observations = all.observations.filter((o) => !alertPaused(paused, o.rule, o.provider));
  // S4 / spec §9.1: CollectorStale itself judges the primary scheduler (cron-job.org), but it mutes the other alerts only
  // when NO scheduler has collected lately: the QStash fallback and manual runs count, so alerts keep working while the
  // fallback is collecting.
  const staleRule = rules.find((r) => r.key === "CollectorStale");
  const lastAny = facts.lastAnyRunAt === undefined ? facts.lastMinuteRunAt : facts.lastAnyRunAt;
  const stale = !!staleRule?.enabled && (!lastAny || now.getTime() - lastAny.getTime() > (staleRule.threshold ?? 5) * 60_000);
  const pausedDb = new Map((facts.dbs ?? []).filter((d) => d.state === "paused").map((d) => [d.id, d.name]));
  const mutedApps = new Map(facts.links.filter((l) => pausedDb.has(l.dbId)).map((l) => [l.appId, `DatabasePaused · ${pausedDb.get(l.dbId)}`]));
  const incidents = new Map(feeds.filter((f) => f.state === "warn" || f.state === "err").map((f) => [f.provider === "gcp" ? "firebase" : f.provider, FEED_LABEL[f.provider] ?? f.provider]));
  // U5 / B3: monitors (and whole apps) inside a maintenance window open no alerts; one still down when it ends opens at once.
  const maintenance = maintenanceSet(windows, facts.monitors.map((m) => ({ id: m.id, appId: m.appId })), now, facts.apps.map((a) => a.id));
  const ctx: PlanContext = { now, collectorStale: stale, mutedApps, incidents, maintenance };
  const open: OpenAlert[] = openRows.filter((a) => isRuleKey(a.ruleKey)).map((a) => ({
    id: a.id, ruleKey: a.ruleKey as RuleKey, subject: a.subject, okStreak: a.okStreak, lastSampleAt: a.lastSampleAt, silencedUntil: a.silencedUntil,
    silencedUntilResolved: a.silencedUntilResolved, notifiedOpen: a.notifiedOpen, lastNotifiedAt: a.lastNotifiedAt, pending: a.pending, pendingSince: a.pendingSince,
  }));
  const plan = planAlerts(open, observations, evaluated, rules, ctx);
  if (!plan.open.length && !plan.touch.length && !plan.resolve.length) return { opened: 0, resolved: 0 };
  await db().transaction(async (tx) => {
    for (const a of plan.open) {
      await tx.insert(alerts).values({ ...a, pendingSince: a.pending ? now : null }).onConflictDoNothing();
    }
    for (const t of plan.touch) {
      const { id, pending, ...rest } = t;
      await tx.update(alerts).set({ ...rest, ...(pending ? { pending, pendingSince: now } : {}) }).where(and(eq(alerts.id, id), isNull(alerts.resolvedAt)));
    }
    for (const r of plan.resolve) {
      await tx.update(alerts).set({ resolvedAt: now, pending: r.pending, pendingSince: r.pending ? now : null }).where(and(eq(alerts.id, r.id), isNull(alerts.resolvedAt)));
    }
  });
  return { opened: plan.open.length, resolved: plan.resolve.length };
}

// The bell and the nav pill: what still needs attention (info alerts go to the digest only). The alerts of a paused
// section (Manage › Sections) are left out until it is turned on again. The count per rule (and account provider, for
// CredentialExpiring) is read beside the section state, not after it (1.2 review minor 4), and the paused ones are
// dropped here with the same rule as activeAlertFilter (lib/sections.ts alertPaused).
export async function openAlertCount(): Promise<number> {
  const [paused, rows] = await Promise.all([
    pausedSections(),
    db().select({ ruleKey: alerts.ruleKey, provider: accounts.provider, n: sql<number>`count(*)::int` }).from(alerts)
      .leftJoin(accounts, eq(accounts.id, alerts.accountId))
      .where(and(isNull(alerts.resolvedAt), inArray(alerts.severity, ["critical", "warning"])))
      .groupBy(alerts.ruleKey, accounts.provider),
  ]);
  return rows.reduce((sum, r) => sum + (alertPaused(paused, r.ruleKey, r.provider) ? 0 : Number(r.n)), 0);
}

export type FiringRow = typeof alerts.$inferSelect & { resourceName: string | null; resourceKind: string | null };
const SEV_ORDER = sql`case ${alerts.severity} when 'critical' then 0 when 'warning' then 1 else 2 end`;

// Open alerts, critical first and newest first, at most 200 (S7). The resource's name and kind come with them (a left
// join: account and collector alerts have none), so the page can link an app's alerts to it.
// `paused`: leave out the alerts of these sections (the Alerts page); the auto-actions step reads them all.
export async function listFiring(paused: ReadonlySet<SectionId> = new Set()): Promise<FiringRow[]> {
  const rows = await db().select({ a: alerts, name: resources.name, kind: resources.kind }).from(alerts)
    .leftJoin(resources, eq(resources.id, alerts.resourceId))
    .where(and(isNull(alerts.resolvedAt), activeAlertFilter(paused))).orderBy(SEV_ORDER, desc(alerts.startedAt)).limit(200);
  return rows.map(({ a, name, kind }) => ({ ...a, resourceName: name ?? null, resourceKind: kind ?? null }));
}

// The open alerts as the bell counts them: without a turned-off section's (Manage › Sections). The public API's
// snapshot, MCP and the office read these (1.2 review minor 5).
export async function listShownFiring(): Promise<FiringRow[]> {
  return listFiring(await pausedSections());
}

// What resolved in the last 7 days, at most 50 (S7).
export async function listResolved(now: Date) {
  const rows = await db().select({ id: alerts.id, ruleKey: alerts.ruleKey, severity: alerts.severity, title: alerts.title, resourceId: alerts.resourceId, startedAt: alerts.startedAt, resolvedAt: alerts.resolvedAt })
    .from(alerts).where(and(isNotNull(alerts.resolvedAt), gte(alerts.resolvedAt, new Date(now.getTime() - 7 * 86_400_000))))
    .orderBy(desc(alerts.resolvedAt)).limit(50);
  return rows.flatMap((r) => (r.resolvedAt ? [{ ...r, resolvedAt: r.resolvedAt }] : []));
}

// hasData: whether the rule's source exists now (a stage 3 or 4 snapshot of a watched resource, the same test as
// loadFacts), so the Rules tab can say "No data yet" instead of "Inactive" (S1).
export async function rulesWithState(): Promise<{ rule: RuleConfig; firing: number; hasData: boolean }[]> {
  const [rules, counts, kinds] = await Promise.all([
    loadRules(),
    db().select({ key: alerts.ruleKey, n: sql<number>`count(*)::int` }).from(alerts).where(isNull(alerts.resolvedAt)).groupBy(alerts.ruleKey),
    db().select({ kind: resources.kind }).from(resources).innerJoin(snapshots, eq(snapshots.resourceId, resources.id))
      .where(and(eq(resources.monitored, true), isNull(resources.goneAt))).groupBy(resources.kind),
  ]);
  const has = new Set(kinds.map((k) => k.kind as string));
  // Stage 4: domains are zones (RDAP) and domain rows (TLS); DNS records live in the zone snapshot (facts-map.ts).
  const data = { databases: ["supabase_project", "neon_project", "firestore"].some((k) => has.has(k)), domains: has.has("domain") || has.has("zone"), dns: has.has("zone") };
  return RULE_KEYS.flatMap((key) => {
    const rule = rules.find((r) => r.key === key);
    if (!rule) return [];
    const need = RULES[key].needs;
    return [{ rule, firing: counts.find((c) => c.key === key)?.n ?? 0, hasData: need === null || data[need] }];
  });
}

// The alert that was changed (so the audit entry can name it), or null when it is already resolved or gone.
export async function silenceAlert(id: string, choice: "1h" | "resolved" | "off", by: string, now: Date): Promise<{ ruleKey: string; title: string; resourceId: string | null } | null> {
  const set = choice === "off" ? { silencedUntil: null, silencedUntilResolved: false, silencedBy: null } : { ...silenceUntil(choice, now), silencedBy: by };
  const [row] = await db().update(alerts).set(set).where(and(eq(alerts.id, id), isNull(alerts.resolvedAt)))
    .returning({ ruleKey: alerts.ruleKey, title: alerts.title, resourceId: alerts.resourceId });
  return row ?? null;
}

// false when the rule's row is missing (0012 seeds them), so the action doesn't report a save that changed nothing.
export async function saveRule(key: RuleKey, v: Omit<RuleConfig, "key">): Promise<boolean> {
  const rows = await db().update(alertRules).set({ ...v, updatedAt: new Date() }).where(eq(alertRules.key, key)).returning({ key: alertRules.key });
  return rows.length > 0;
}

// 1.2.4: the rules' custom notification texts, one ops.settings row (no migration): { "<rule key>": { id?, en? } }.
// Unreadable means none, so every rule falls back to Watchbell's wording.
export async function readMessageTemplates(): Promise<MessageTemplates> {
  try {
    const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, TEMPLATES_KEY)).limit(1);
    return parseTemplates(row?.value);
  } catch {
    return {};
  }
}

// Replaces one rule's texts; an empty `t` removes the rule from the row.
export async function saveRuleTemplates(key: RuleKey, t: RuleTemplates): Promise<void> {
  const all = await readMessageTemplates();
  if (Object.keys(t).length) all[key] = t;
  else delete all[key];
  await db().insert(settings).values({ key: TEMPLATES_KEY, value: all }).onConflictDoUpdate({ target: settings.key, set: { value: all, updatedAt: new Date() } });
}
