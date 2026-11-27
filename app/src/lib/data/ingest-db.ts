import "server-only";
// Watchbell 1.8.6 (docs/superpowers/specs/2026-11-25-watchbell-1-8-6-alertmanager-design.md): the sources that may post
// alerts, and what their alerts do to ops.alerts. The alert lifecycle is the collector's own (lib/alerts/lifecycle.ts
// planAlerts), so an ExternalAlert opens, repeats, is silenced, waits out maintenance and resolves exactly like a
// Watchbell rule; only who observes it differs.
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { type IngestSource, ingestSources } from "@/db/ingest-schema";
import { alerts } from "@/db/schema";
import type { Observation } from "@/lib/alerts/evaluate";
import { type OpenAlert, type PlanContext, planAlerts } from "@/lib/alerts/lifecycle";
import { AM_STALE_MS, type ExternalAlertInput } from "@/lib/ingest/alertmanager";
import { newIngestToken } from "@/lib/ingest/token";
import { maintenanceSet } from "@/lib/maintenance";
import { loadRules } from "./alerts-db";
import { listRawWindows } from "./maintenance-db";

export type { IngestSource };
export const TEST_SUBJECT = "am:watchbell-test";
const TEST_STALE_MS = 5 * 60_000;
const ALL = "\u0000all"; // a key no app id can be: present only while an "all" maintenance window is live

export async function findSourceByHash(hash: string): Promise<IngestSource | null> {
  const [row] = await db().select().from(ingestSources).where(and(eq(ingestSources.tokenHash, hash), eq(ingestSources.enabled, true))).limit(1);
  return row ?? null;
}

// A new source of a kind replaces the enabled one (the UI shows one source per kind; the table allows more later).
export async function createSource(kind: "alertmanager", name = "Alertmanager"): Promise<{ token: string; prefix: string; id: string }> {
  const t = newIngestToken();
  const id = await db().transaction(async (tx) => {
    await tx.update(ingestSources).set({ enabled: false }).where(and(eq(ingestSources.kind, kind), eq(ingestSources.enabled, true)));
    const [row] = await tx.insert(ingestSources).values({ kind, name, tokenHash: t.hash, tokenPrefix: t.prefix }).returning({ id: ingestSources.id });
    return row.id;
  });
  return { token: t.token, prefix: t.prefix, id };
}

// Every enabled source of the kind (final review M1: two set-ups at once can leave two enabled, and a revoke must stop
// both). Returns how many it stopped.
export async function revokeSources(kind: "alertmanager"): Promise<number> {
  const rows = await db().update(ingestSources).set({ enabled: false }).where(and(eq(ingestSources.kind, kind), eq(ingestSources.enabled, true))).returning({ id: ingestSources.id });
  return rows.length;
}

export async function readSources(): Promise<IngestSource[]> {
  return db().select().from(ingestSources).orderBy(desc(ingestSources.createdAt), desc(ingestSources.id));
}

// "This month" counters roll over on the first call of a new month; last seen moves only when an alert was accepted.
export async function countIngest(src: IngestSource, accepted: number, refused: number, now: Date): Promise<void> {
  const month = now.toISOString().slice(0, 7);
  await db().update(ingestSources).set({
    monthKey: month,
    receivedMonth: sql`case when ${ingestSources.monthKey} = ${month} then ${ingestSources.receivedMonth} + ${accepted} else ${accepted} end`,
    refusedMonth: sql`case when ${ingestSources.monthKey} = ${month} then ${ingestSources.refusedMonth} + ${refused} else ${refused} end`,
    ...(accepted > 0 ? { lastSeenAt: now } : {}),
  }).where(eq(ingestSources.id, src.id));
}

// One call's alerts, in one transaction. The last state of a fingerprint in the call wins (a firing then a resolved
// of the same alert = resolved). A resolved for an alert Watchbell never opened changes nothing; the rule turned off
// opens nothing. The alert's own severity, title and labels replace the plan's defaults.
export async function applyExternalAlerts(_src: IngestSource, input: ExternalAlertInput[], now: Date): Promise<{ opened: number; touched: number; resolved: number }> {
  const none = { opened: 0, touched: 0, resolved: 0 };
  const last = new Map<string, ExternalAlertInput>();
  for (const a of input) { last.delete(a.subject); last.set(a.subject, a); }
  if (!last.size) return none;
  const [rules, openRows, windows] = await Promise.all([
    loadRules(),
    db().select().from(alerts).where(and(eq(alerts.ruleKey, "ExternalAlert"), isNull(alerts.resolvedAt), inArray(alerts.subject, [...last.keys()]))),
    listRawWindows(),
  ]);
  const rule = rules.find((r) => r.key === "ExternalAlert");
  if (!rule?.enabled) return none;
  const obs: Observation[] = [...last.values()].map((a) => ({
    rule: "ExternalAlert", subject: a.subject, status: a.status === "firing" ? "firing" : "ok", resourceId: null, accountId: null,
    title: a.title, message: a.message, provider: null, sampleAt: null,
  }));
  const inMaintenance = maintenanceSet(windows, [], now, [ALL]).has(ALL);
  const ctx: PlanContext = { now, collectorStale: false, mutedApps: new Map(), incidents: new Map(), maintenance: new Set(inMaintenance ? last.keys() : []) };
  const open: OpenAlert[] = openRows.map((a) => ({
    id: a.id, ruleKey: "ExternalAlert", subject: a.subject, okStreak: a.okStreak, lastSampleAt: a.lastSampleAt, silencedUntil: a.silencedUntil,
    silencedUntilResolved: a.silencedUntilResolved, notifiedOpen: a.notifiedOpen, lastNotifiedAt: a.lastNotifiedAt, pending: a.pending, pendingSince: a.pendingSince,
  }));
  const plan = planAlerts(open, obs, new Set(["ExternalAlert"]), rules, ctx);
  const subjectOf = new Map(openRows.map((a) => [a.id, a.subject]));
  await db().transaction(async (tx) => {
    for (const a of plan.open) {
      const src = last.get(a.subject)!;
      await tx.insert(alerts).values({
        ...a, severity: src.severity ?? rule.severity, labels: src.labels, startedAt: src.startedAt, pendingSince: a.pending ? now : null,
      }).onConflictDoNothing();
    }
    for (const t of plan.touch) {
      const { id, pending, ...rest } = t;
      const src = last.get(subjectOf.get(id) ?? "");
      await tx.update(alerts).set({
        ...rest, ...(pending ? { pending, pendingSince: now } : {}),
        ...(src ? { severity: src.severity ?? rule.severity, title: src.title, labels: src.labels } : {}),
      }).where(and(eq(alerts.id, id), isNull(alerts.resolvedAt)));
    }
    for (const r of plan.resolve) {
      await tx.update(alerts).set({ resolvedAt: now, pending: r.pending, pendingSince: r.pending ? now : null }).where(and(eq(alerts.id, r.id), isNull(alerts.resolvedAt)));
    }
  });
  return { opened: plan.open.length, touched: plan.touch.length, resolved: plan.resolve.length };
}

// The minute step (lib/collector/core-minute-steps.ts): an external alert with no word for 24 h resolves as stale; the
// Watchbell test alert (Alerts › Sources › Send a test alert) resolves after 5 minutes.
export async function resolveStaleExternal(now: Date): Promise<number> {
  const rows = await db().update(alerts).set({
    resolvedAt: now,
    pending: sql`case when ${alerts.notifiedOpen} then 'resolve' else null end`,
    pendingSince: sql`case when ${alerts.notifiedOpen} then ${now.toISOString()}::timestamptz else null end`,
  }).where(and(
    eq(alerts.ruleKey, "ExternalAlert"), isNull(alerts.resolvedAt),
    or(lt(alerts.lastSeenAt, new Date(now.getTime() - AM_STALE_MS)), and(eq(alerts.subject, TEST_SUBJECT), lt(alerts.lastSeenAt, new Date(now.getTime() - TEST_STALE_MS)))),
  )).returning({ id: alerts.id });
  return rows.length;
}

// Alerts › Sources › "Last 5 received".
export async function recentExternal(limit = 5): Promise<{ title: string; status: "firing" | "resolved"; at: Date }[]> {
  const at = sql<Date>`coalesce(${alerts.resolvedAt}, ${alerts.lastSeenAt})`;
  const rows = await db().select({ title: alerts.title, resolvedAt: alerts.resolvedAt, lastSeenAt: alerts.lastSeenAt }).from(alerts)
    .where(eq(alerts.ruleKey, "ExternalAlert")).orderBy(desc(at), desc(alerts.id)).limit(limit);
  return rows.map((r) => ({ title: r.title, status: r.resolvedAt ? "resolved" : "firing", at: r.resolvedAt ?? r.lastSeenAt }));
}
