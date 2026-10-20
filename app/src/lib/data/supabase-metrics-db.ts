import "server-only";
import { and, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { db } from "@/db/client";
import { supabaseMetrics, supabaseMetricsKeys } from "@/db/compute-schema";
import { resources, snapshots } from "@/db/schema";
import { openOrNull, seal } from "@/lib/crypto";
import {
  type ComputeFact, extractSample, hourStart, mergeHour, nextLatest, parsePrometheus, RETENTION_DAYS, scrapeDue,
} from "@/lib/databases/compute-metrics";
import { serverEnv } from "@/lib/env";
import { isUuid } from "@/lib/ids";
import { fetchSupabaseMetrics, isProjectRef, isSecretKey } from "@/lib/providers/supabase-metrics";
import type { ComputeRead } from "@/lib/view/usage";
import type { Done } from "./monitors-db";

// Stage 12: the owner's per-project metrics keys, the 5-minute scrape (from the minute run, after the response) and the
// reads for the Supabase page, the alert facts and the office patrol. The key is sealed at rest, opened only to call
// that project's Metrics API, and never returned to a page, a log line or an error text.

const CALL_MS = 8_000;
const MAX_PROJECTS = 20;
const HOUR = 3_600_000;
const ERROR_MAX = 300;

const watchedSupabase = (resourceId: string) =>
  and(eq(resources.id, resourceId), eq(resources.kind, "supabase_project"), isNull(resources.goneAt));

// ---- the owner's key (server actions in app/(console)/supabase/metrics-actions.ts check the role and the quota) ----

export type KeyDeps = { fetchMetrics: typeof fetchSupabaseMetrics };
const defaults: KeyDeps = { fetchMetrics: fetchSupabaseMetrics };

// Saves (or replaces) the key after one test call: a key Supabase rejects is not stored; a timeout or 5xx stores it
// (the beta endpoint can be slow) and says so. The test call's answer becomes the first scrape.
export async function saveMetricsKey(resourceId: string, expectedRef: string, key: string, actorUserId: string, now = new Date(), deps: KeyDeps = defaults): Promise<Done> {
  if (!isUuid(resourceId) || !isProjectRef(expectedRef) || !isSecretKey(key)) return { ok: false, error: "Something in that request wasn't valid." };
  const [r] = await db().select({ id: resources.id, name: resources.name, ref: resources.externalId }).from(resources).where(watchedSupabase(resourceId)).limit(1);
  if (!r) return { ok: false, error: "That Supabase project is no longer watched." };
  if (r.ref !== expectedRef) return { ok: false, error: "This changed since you opened it. Reload and try again." };
  const test = await deps.fetchMetrics(r.ref, key, { timeoutMs: CALL_MS });
  if (!test.ok && (test.kind === "auth" || test.kind === "missing")) return { ok: false, error: test.error };
  const sealed = seal(key, serverEnv().OPS_ENCRYPTION_KEY);
  const latest = test.ok ? nextLatest(null, extractSample(parsePrometheus(test.data), r.ref), now) : null;
  const set = {
    keyCiphertext: sealed.ciphertext, keyIv: sealed.iv, keyVersion: sealed.keyVersion, addedBy: actorUserId, updatedAt: now,
    latest, lastTryAt: now, lastOkAt: test.ok ? now : null, lastError: test.ok ? null : test.error.slice(0, ERROR_MAX),
  };
  await db().insert(supabaseMetricsKeys).values({ resourceId, ...set }).onConflictDoUpdate({ target: supabaseMetricsKeys.resourceId, set });
  return {
    ok: true,
    message: test.ok ? `Metrics key saved for ${r.name}. CPU shows after the next scrape (about 5 minutes).` : `Metrics key saved for ${r.name}, but the test call failed: ${test.error}`,
    audit: { message: `Metrics key saved · ${r.name}`, resourceId },
  };
}

// Removes the key and the project's rollups (Supabase-side the owner revokes the key in Project Settings → API Keys).
export async function removeMetricsKey(resourceId: string): Promise<Done> {
  if (!isUuid(resourceId)) return { ok: false, error: "Something in that request wasn't valid." };
  const [r] = await db().select({ name: resources.name }).from(resources).where(and(eq(resources.id, resourceId), eq(resources.kind, "supabase_project"))).limit(1);
  const gone = await db().delete(supabaseMetricsKeys).where(eq(supabaseMetricsKeys.resourceId, resourceId)).returning({ id: supabaseMetricsKeys.resourceId });
  if (!gone.length) return { ok: false, error: "This project has no metrics key." };
  await db().delete(supabaseMetrics).where(eq(supabaseMetrics.resourceId, resourceId));
  const name = r?.name ?? "project";
  return { ok: true, message: `Metrics key removed for ${name}. Revoke it in Supabase too.`, audit: { message: `Metrics key removed · ${name}`, resourceId } };
}

// ---- the scrape (minute run, at most once per 5-minute slot per instance) ----

let lastScrape: number | null = null;
export function resetScrapeThrottle(): void {
  lastScrape = null;
}

export type ScrapeDeps = { fetchMetrics: typeof fetchSupabaseMetrics; key: () => string };
const scrapeDefaults: ScrapeDeps = { fetchMetrics: fetchSupabaseMetrics, key: () => serverEnv().OPS_ENCRYPTION_KEY };
const safe = (e: unknown) => (e instanceof Error ? e.name : "unknown");

// Never throws. Each project: one GET bounded by 8 s and the run's deadline; its failure is stored on its own row.
export async function scrapeSupabaseMetrics(now: Date, deadline: number, deps: ScrapeDeps = scrapeDefaults): Promise<{ scraped: number; failed: number } | null> {
  if (!scrapeDue(now, lastScrape)) return null;
  lastScrape = now.getTime();
  let scraped = 0;
  let failed = 0;
  try {
    const rows = await db().select({ k: supabaseMetricsKeys, ref: resources.externalId, state: snapshots.state }).from(supabaseMetricsKeys)
      .innerJoin(resources, eq(resources.id, supabaseMetricsKeys.resourceId))
      .leftJoin(snapshots, eq(snapshots.resourceId, resources.id))
      .where(and(eq(resources.kind, "supabase_project"), eq(resources.monitored, true), isNull(resources.goneAt)))
      .limit(MAX_PROJECTS);
    for (const { k, ref, state } of rows) {
      const left = deadline - Date.now() - 500;
      if (left < 1_000) break;
      try {
        const ok = await scrapeOne(k, ref, state, now, Math.min(CALL_MS, left), deps);
        if (ok) scraped++;
        else failed++;
      } catch (e) {
        failed++;
        console.warn("supabase-metrics: one project failed:", safe(e));
      }
    }
    await db().delete(supabaseMetrics).where(lt(supabaseMetrics.hour, new Date(now.getTime() - RETENTION_DAYS * 24 * HOUR)));
  } catch (e) {
    console.warn("supabase-metrics failed:", safe(e));
  }
  return { scraped, failed };
}

type KeyRow = typeof supabaseMetricsKeys.$inferSelect;

async function fail(resourceId: string, now: Date, error: string): Promise<false> {
  await db().update(supabaseMetricsKeys).set({ lastTryAt: now, lastError: error.slice(0, ERROR_MAX) }).where(eq(supabaseMetricsKeys.resourceId, resourceId));
  return false;
}

async function scrapeOne(k: KeyRow, ref: string, state: string | null, now: Date, timeoutMs: number, deps: ScrapeDeps): Promise<boolean> {
  // A paused project has no database server to read; Restore brings the numbers back.
  if (state === "paused") return fail(k.resourceId, now, "The project is paused.");
  const key = openOrNull({ ciphertext: k.keyCiphertext, iv: k.keyIv }, deps.key());
  if (!key) return fail(k.resourceId, now, "The stored key can't be read. Add it again.");
  const res = await deps.fetchMetrics(ref, key, { timeoutMs });
  if (!res.ok) return fail(k.resourceId, now, res.error);
  const latest = nextLatest(k.latest ?? null, extractSample(parsePrometheus(res.data), ref), now);
  await db().update(supabaseMetricsKeys).set({ latest, lastTryAt: now, lastOkAt: now, lastError: null }).where(eq(supabaseMetricsKeys.resourceId, k.resourceId));
  const hour = hourStart(now);
  const [h] = await db().select().from(supabaseMetrics).where(and(eq(supabaseMetrics.resourceId, k.resourceId), eq(supabaseMetrics.hour, hour))).limit(1);
  const merged = mergeHour(h ?? null, latest);
  await db().insert(supabaseMetrics).values({ resourceId: k.resourceId, hour, ...merged })
    .onConflictDoUpdate({ target: [supabaseMetrics.resourceId, supabaseMetrics.hour], set: merged });
  return true;
}

// ---- reads ----

// The Supabase page: per project with a key, the latest values and the last 24 hourly rollups. Projects without a key
// are absent from the map. No secret columns are selected.
export async function readCompute(resourceIds: string[], now = new Date()): Promise<Map<string, ComputeRead>> {
  const ids = resourceIds.filter(isUuid);
  const out = new Map<string, ComputeRead>();
  if (!ids.length) return out;
  const keys = await db().select({
    resourceId: supabaseMetricsKeys.resourceId, latest: supabaseMetricsKeys.latest, lastTryAt: supabaseMetricsKeys.lastTryAt,
    lastOkAt: supabaseMetricsKeys.lastOkAt, lastError: supabaseMetricsKeys.lastError,
  }).from(supabaseMetricsKeys).where(inArray(supabaseMetricsKeys.resourceId, ids));
  if (!keys.length) return out;
  const hours = await db().select().from(supabaseMetrics)
    .where(and(inArray(supabaseMetrics.resourceId, keys.map((k) => k.resourceId)), gte(supabaseMetrics.hour, new Date(hourStart(now).getTime() - 23 * HOUR))))
    .limit(keys.length * 24);
  for (const k of keys) {
    out.set(k.resourceId, {
      latest: k.latest ?? null, lastTryAt: k.lastTryAt, lastOkAt: k.lastOkAt, lastError: k.lastError,
      hours: hours.filter((h) => h.resourceId === k.resourceId),
    });
  }
  return out;
}

// Alert facts (ComputeHigh) and the patrol: watched projects with a key, their latest values. Null when no project has
// a key (the rule's source doesn't exist yet, so it isn't evaluated).
export async function computeFacts(): Promise<ComputeFact[] | null> {
  const rows = await db().select({ id: resources.id, name: resources.name, latest: supabaseMetricsKeys.latest }).from(supabaseMetricsKeys)
    .innerJoin(resources, eq(resources.id, supabaseMetricsKeys.resourceId))
    .where(and(eq(resources.kind, "supabase_project"), eq(resources.monitored, true), isNull(resources.goneAt)))
    .limit(MAX_PROJECTS);
  return rows.length ? rows.map((r) => ({ id: r.id, name: r.name, latest: r.latest ?? null })) : null;
}
