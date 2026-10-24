import "server-only";
import { and, eq, isNotNull, not, or, type SQL, sql } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/db/client";
import { rowsOf } from "@/db/rows";
import { accounts, alerts, monitors, resources } from "@/db/schema";
import { type Provider, PROVIDERS } from "@/lib/providers/info";
import { cleanSectionsOff, pausedAlertKeys, pausedSections as pausedOf, type SectionId, sectionsAvailable } from "@/lib/sections";
import { sectionsOffSql } from "./settings-db";

// Watchbell 1.2 (D11): which sections are on, and which ones the owner paused. See lib/sections.ts.

// The resource kinds the Database section lists (Supabase, Neon, Firestore, Turso, Upstash Redis, Cloudflare D1).
export const DATABASE_KINDS = ["supabase_project", "neon_project", "firestore", "turso_database", "upstash_redis", "d1_database"] as const;

// available: before the owner's switches (Database and DevOps only with a provider or data); on: what is shown.
export type SectionState = { on: SectionId[]; available: SectionId[]; off: SectionId[]; providers: Provider[]; has: { databases: boolean } };

// jsonb comes back parsed from both drivers; a string (an older driver setting) is parsed here.
const json = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
};

// One statement (review A1, perf): the connected providers, whether a database resource exists and the owner's
// switch. Read once per request (React cache): the layout, the bell count and the page share it.
const readState = cache(async (): Promise<{ providers: Provider[]; databases: boolean; off: SectionId[] }> => {
  const kinds = sql.join(DATABASE_KINDS.map((k) => sql`${k}`), sql`, `);
  const res = await db().execute(sql`select
    (select coalesce(jsonb_agg(distinct ${accounts.provider}::text), '[]'::jsonb) from ${accounts}) as providers,
    exists(select 1 from ${resources} where ${resources.kind}::text in (${kinds}) and ${resources.goneAt} is null) as databases,
    ${sectionsOffSql()} as off`);
  const [row] = rowsOf<{ providers: unknown; databases: unknown; off: unknown }>(res);
  const list = json(row?.providers);
  // Google Drive (backups) is an account too, but no section's.
  const providers = (Array.isArray(list) ? list : []).filter((p): p is Provider => (PROVIDERS as readonly string[]).includes(p));
  return { providers, databases: row?.databases === true || row?.databases === "t", off: cleanSectionsOff(json(row?.off)) };
});

export async function sectionState(): Promise<SectionState> {
  const { providers, databases, off } = await readState();
  const has = { databases };
  const available = [...sectionsAvailable(providers, has)];
  return { on: available.filter((id) => !off.includes(id)), available, off, providers, has };
}

// The sections whose collector tasks, alert evaluation, notifications and new proposals pause. A failed read pauses
// nothing (keep watching rather than go quiet).
export async function pausedSections(): Promise<Set<SectionId>> {
  try {
    return pausedOf((await readState()).off);
  } catch {
    return new Set();
  }
}

// The alerts of the paused sections (lib/sections.ts RULE_SECTION; an expiring credential by its account's provider),
// or undefined when nothing is paused.
export function pausedAlertCondition(paused: ReadonlySet<SectionId>): SQL | undefined {
  if (!paused.size) return undefined;
  const { ruleKeys, providers } = pausedAlertKeys(paused);
  const out: SQL[] = [];
  if (ruleKeys.length) out.push(sql`${alerts.ruleKey} in (${sql.join(ruleKeys.map((k) => sql`${k}`), sql`, `)})`);
  if (providers.length) {
    const list = sql.join(providers.map((p) => sql`${p}`), sql`, `);
    out.push(sql`(${alerts.ruleKey} = 'CredentialExpiring' and ${alerts.accountId} in (select ${accounts.id} from ${accounts} where ${accounts.provider}::text in (${list})))`);
  }
  return out.length ? or(...out) : undefined;
}

// A WHERE condition on ops.alerts that leaves out the alerts of paused sections, or undefined when nothing is paused.
// The alerts stay as they are. (An account_id that is null never matches the `in`, so the `not` keeps those rows.)
export function activeAlertFilter(paused: ReadonlySet<SectionId>): SQL | undefined {
  const c = pausedAlertCondition(paused);
  return c ? not(c) : undefined;
}

// Turning a section on again: its notices that waited while it was off restart their 30-minute delivery window, so a
// still-firing alert goes out on the next run instead of being dropped as stale (review A1, minor 4).
export async function releaseHeldNotices(section: SectionId, now: Date): Promise<void> {
  const c = pausedAlertCondition(new Set([section]));
  if (!c) return;
  await db().update(alerts).set({ pendingSince: now }).where(and(isNotNull(alerts.pending), c));
}

// What turning Hosting off stops, for the confirm step: the HTTP checks and heartbeats that run now.
export async function monitorCounts(): Promise<{ http: number; heartbeat: number }> {
  const rows = await db().select({ kind: monitors.kind, n: sql<number>`count(*)::int` }).from(monitors)
    .where(and(eq(monitors.paused, false), eq(monitors.ownerPaused, false))).groupBy(monitors.kind);
  const n = (k: string) => Number(rows.find((r) => r.kind === k)?.n ?? 0);
  return { http: n("http"), heartbeat: n("heartbeat") };
}
