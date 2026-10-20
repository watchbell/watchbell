import "server-only";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, checks, deployments, links, monitors, resources, snapshots } from "@/db/schema";
import type { Facts, LinkFact } from "@/lib/alerts/facts";
import { dbFact, dnsFacts, domainFacts } from "@/lib/alerts/facts-map";
import { lastCollectorRunAt, lastMinuteRunAt } from "@/lib/collector/last-run";
import { computeFacts } from "@/lib/data/supabase-metrics-db";
import { loadAppDeps } from "@/lib/data/deps-db";

const TEN_MIN = 10 * 60_000;

// Which app uses which database (A3): stage 3's `links` table, kind uses_db (at most one per app, so ≤ 500 rows).
async function loadLinks(): Promise<LinkFact[]> {
  return db().select({ appId: links.fromResourceId, dbId: links.toResourceId }).from(links).where(eq(links.kind, "uses_db")).limit(500);
}

// Bounded reads (R8): watched resources only, checks of the last 10 minutes as one aggregate (U5: without the ones made
// inside a maintenance window, so a slow window doesn't fire HighLatency the minute it ends), the latest production
// deployment per app via DISTINCT ON. About 8 queries.
export async function loadFacts(now: Date): Promise<Facts> {
  const watched = and(eq(resources.monitored, true), isNull(resources.goneAt));
  const [lastRun, lastAny, mons, apps, accs] = await Promise.all([
    lastMinuteRunAt(), lastCollectorRunAt(),
    db().select({ m: monitors, appName: resources.name }).from(monitors).innerJoin(resources, eq(resources.id, monitors.resourceId))
      .where(and(watched, eq(monitors.paused, false), eq(monitors.ownerPaused, false))),
    db().select({ id: resources.id, name: resources.name }).from(resources).where(and(watched, eq(resources.kind, "app"))),
    db().select({ id: accounts.id, provider: accounts.provider, label: accounts.label, expiresAt: accounts.expiresAt, status: accounts.status, lastError: accounts.lastError }).from(accounts),
  ]);
  const monIds = mons.map((r) => r.m.id);
  const lat = monIds.length ? await db().select({
    id: checks.monitorId, n: sql<number>`count(*)::int`,
    p95: sql<number | null>`percentile_cont(0.95) within group (order by ${checks.latencyMs})::float8`,
  }).from(checks).where(and(inArray(checks.monitorId, monIds), gte(checks.at, new Date(now.getTime() - TEN_MIN)), eq(checks.inMaintenance, false))).groupBy(checks.monitorId) : [];
  const appIds = apps.map((a) => a.id);
  const latest = appIds.length ? await db().selectDistinctOn([deployments.resourceId], {
    appId: deployments.resourceId, state: deployments.state, sha: deployments.commitSha, createdAt: deployments.createdAtProvider,
  }).from(deployments).where(and(inArray(deployments.resourceId, appIds), eq(deployments.target, "production")))
    .orderBy(deployments.resourceId, desc(deployments.createdAtProvider)) : [];

  const snaps = await db().select({ id: resources.id, name: resources.name, kind: resources.kind, state: snapshots.state, data: snapshots.data })
    .from(resources).innerJoin(snapshots, eq(snapshots.resourceId, resources.id))
    .where(and(watched, inArray(resources.kind, ["supabase_project", "neon_project", "firestore", "turso_database", "upstash_redis", "d1_database", "zone", "domain"])));
  const of = (k: string) => snaps.filter((s) => s.kind === k);
  const dbRows = snaps.filter((s) => ["supabase_project", "neon_project", "firestore", "turso_database", "upstash_redis", "d1_database"].includes(s.kind));
  const zones = of("zone");
  const domainRows = of("domain");
  const linkRows = await loadLinks();
  // Stage 12: a failed read leaves ComputeHigh unevaluated (its open alerts stay) instead of failing every rule.
  const compute = await computeFacts().catch(() => null);
  // Stage 9 slice 5: the scanned apps' open dependency advisories (null until the first scan: rule not evaluated).
  const deps = appIds.length ? await loadAppDeps(appIds).catch(() => null) : null;

  return {
    now, lastMinuteRunAt: lastRun, lastAnyRunAt: lastAny,
    monitors: mons.map(({ m, appName }) => {
      const l = lat.find((x) => x.id === m.id);
      // A heartbeat (U3) is titled "{app} {name}" by the evaluator, which reads its state rather than a fail streak.
      const hb = m.kind === "heartbeat";
      return {
        id: m.id, appId: m.resourceId, appName, url: hb ? (m.name ?? "heartbeat") : m.url, kind: hb ? "heartbeat" as const : "http" as const,
        state: m.state, failStreak: m.failStreak, lastStatus: m.lastStatus, lastError: m.lastError,
        lastCheckedAt: m.lastCheckedAt, p95Last10: l?.p95 ?? null, checksLast10: l?.n ?? 0,
      };
    }),
    apps: apps.map((a) => {
      const d = latest.find((x) => x.appId === a.id);
      return { id: a.id, name: a.name, latestProduction: d ? { state: d.state, sha: d.sha, createdAt: d.createdAt } : null };
    }),
    accounts: accs,
    dbs: dbRows.length ? dbRows.map((r) => dbFact(r, now)).filter((x) => x !== null) : null,
    domains: domainFacts(zones, domainRows),
    dns: dnsFacts(zones, domainRows),
    links: linkRows,
    compute,
    deps: deps && deps.length ? deps : null,
  };
}
