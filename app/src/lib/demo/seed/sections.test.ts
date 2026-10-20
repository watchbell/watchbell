import { PGlite } from "@electric-sql/pglite";
import { asc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import { rowsOf } from "@/db/rows";
import * as schema from "@/db/schema";
import { accounts, alerts, events, keepActive, links, providerStatus, resources, settings, snapshots, storedLogs } from "@/db/schema";
import { supabaseMetrics, supabaseMetricsKeys } from "@/db/compute-schema";

// Task 5: every console section's loader returns data against a seeded visitor database. The loaders read through
// db(), which is the seeded in-memory PGlite here (the uncached data functions: lib/data/cached.ts only adds the cloud
// cache in front of them).
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));

import { evaluateAlerts, listFiring, listResolved, rulesWithState } from "@/lib/data/alerts-db";
import { readAliasBook } from "@/lib/data/aliases-db";
import { listRecommendations } from "@/lib/data/advisor-db";
import { listApps } from "@/lib/data/apps-db";
import { listDatabases, supabaseSlotInputs } from "@/lib/data/databases-db";
import { listDeployments } from "@/lib/data/deployments-db";
import { listEvents } from "@/lib/data/events-db";
import { keepActiveFlags } from "@/lib/data/keep-active-db";
import { listStoredLogs } from "@/lib/data/logs-db";
import { listMonitors } from "@/lib/data/monitors-db";
import { getZoneView, listDomains, listZoneOptions } from "@/lib/data/network-db";
import { brokenAccounts } from "@/lib/data/overview-db";
import { listProviderStatus } from "@/lib/data/provider-status-db";
import { readCompute } from "@/lib/data/supabase-metrics-db";
import { topologyColumns } from "@/lib/data/topology-db";
import { firebaseRows, neonBlocks, slotCards, supabaseRows } from "@/lib/view/databases";
import { d1Views, tursoViews, upstashViews } from "@/lib/view/extra-dbs";
import { computePanel } from "@/lib/view/usage";
import { seedDemoDb } from "./index";

type Drizzle = ReturnType<typeof drizzle<typeof schema>>;
const NOW = new Date("2026-10-19T05:03:27.000Z");
const SEED = "5e6d7c8b9a0f1e2d3c4b5a6978877665";
const EMAIL = "visitor@example.com";

const opened: PGlite[] = [];
async function fresh(): Promise<Drizzle> {
  const client = await PGlite.create();
  opened.push(client);
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  return db;
}

let a: Drizzle;
let seedMs = 0;
beforeAll(async () => {
  a = await fresh();
  const t0 = performance.now();
  await seedDemoDb(a, SEED, NOW, EMAIL);
  seedMs = performance.now() - t0;
  h.db = a;
}, 120_000);

afterAll(async () => {
  await Promise.all(opened.map((c) => c.close().catch(() => undefined)));
});

const q = async <T>(s: ReturnType<typeof sql>) => rowsOf<T>(await a.execute(s));

describe("demo dataset: every console section has data", () => {
  it("seeds everything in well under 10 s (about 1 s on a laptop)", () => {
    expect(seedMs).toBeLessThan(10_000);
  });

  it("Overview and Applications: apps, recommendations, no broken account", async () => {
    expect((await listApps(NOW)).length).toBeGreaterThanOrEqual(5);
    expect(await brokenAccounts()).toEqual([]);
    expect(Array.isArray(await listRecommendations(NOW))).toBe(true);
    expect((await listDeployments()).length).toBeGreaterThan(0);
    expect((await listMonitors(NOW)).length).toBeGreaterThan(0);
  });

  it("Databases: one watched database per provider, each with its usage numbers", async () => {
    const book = await readAliasBook();
    const supa = await listDatabases("supabase_project");
    expect(supa).toHaveLength(1);
    const [sv] = supabaseRows(supa, NOW, book);
    expect(sv).toMatchObject({ status: { state: "ok" }, paused: false });
    expect(sv.size?.pct).toBeGreaterThan(0);
    expect(sv.risk.state).toBe("ok");
    expect(sv.usedBy.length).toBeGreaterThan(0);
    expect(slotCards(await supabaseSlotInputs())).toEqual([expect.objectContaining({ used: 1, total: 2 })]);
    const compute = await readCompute([sv.id], NOW);
    expect(computePanel(compute.get(sv.id), NOW)).toMatchObject({ kind: "ok", stale: false });
    expect((await keepActiveFlags([sv.id])).get(sv.id)).toMatchObject({ keep: true });

    const [neon] = neonBlocks(await listDatabases("neon_project"), NOW, book);
    expect(neon.cu?.pct).toBeGreaterThan(0);
    expect(neon.cu!.pct).toBeLessThan(80);
    expect(neon.branches).toHaveLength(2);
    expect(neon.status.state).not.toBe("unknown");

    const [fire] = firebaseRows(await listDatabases("firestore"), book);
    expect(fire.health.state).toBe("ok");
    expect(fire.ops).toMatchObject({ reads: { n: expect.any(Number) } });

    for (const [kind, view] of [["turso_database", tursoViews], ["upstash_redis", upstashViews], ["d1_database", d1Views]] as const) {
      const [v] = view(await listDatabases(kind), NOW, book);
      expect(v.status.state, kind).toBe("ok");
      const pcts = v.meters.map((m) => m.pct).filter((p): p is number => p !== null);
      expect(pcts.length, kind).toBeGreaterThanOrEqual(2);
      expect(Math.max(...pcts), kind).toBeLessThan(80); // under DbQuotaHigh / StorageAlmostFull
    }
    const [d1Access] = await a.select().from(settings).where(sql`key = 'd1.access'`);
    expect(Object.keys(d1Access.value as object)).toHaveLength(1);
  });

  it("Network: 2 zones and 6 domains under .example, one certificate and one zone expiring soon", async () => {
    const zones = await listZoneOptions();
    expect(zones).toHaveLength(2);
    expect(zones.every((z) => /^[a-z0-9-]+\.example$/.test(z.name))).toBe(true);
    const zone = await getZoneView(null);
    expect(zone?.facts.records.length).toBeGreaterThanOrEqual(4);
    expect(zone?.facts.rdap?.expiresAt).toBeTruthy();

    const doms = await listDomains();
    expect(doms).toHaveLength(6);
    expect(doms.every((d) => d.name.endsWith(".example") && d.zoneName && d.appId && d.tls && d.records.some((r) => r.type === "A" && !r.proxied))).toBe(true);
    const certSoon = doms.filter((d) => d.reasons.some((r) => r.startsWith("Certificate expires in")));
    expect(certSoon).toHaveLength(1);
    expect(doms.filter((d) => d.reasons.some((r) => r.startsWith("Domain expires in"))).length).toBeGreaterThanOrEqual(1);
  });

  it("Topology: domains, apps and databases, with app → database edges", async () => {
    const [dom, app, dbs] = await topologyColumns(NOW, await readAliasBook());
    expect(dom).toHaveLength(6);
    expect(app.length).toBeGreaterThanOrEqual(5);
    expect(dbs).toHaveLength(6);
    expect(app.filter((n) => n.links.length > 0).length).toBeGreaterThanOrEqual(4);
  });

  it("Alerts: 3 firing on seeded resources, about 10 resolved this week, the rules have data", async () => {
    const firing = await listFiring();
    expect(firing.map((f) => f.ruleKey).sort()).toEqual(["CertExpiringSoon", "DeploymentFailed", "DomainExpiringSoon"]);
    expect(firing.every((f) => f.resourceId && f.resourceName)).toBe(true);
    const resolved = await listResolved(NOW);
    expect(resolved.length).toBeGreaterThanOrEqual(8);
    expect(resolved.length).toBeLessThanOrEqual(12);
    expect((await rulesWithState()).every((r) => r.hasData)).toBe(true);
  });

  it("each resolved alert matches the rows it is about", async () => {
    type A = { id: string; rule_key: string; subject: string; title: string; resource_id: string | null; started_at: Date; resolved_at: Date | null };
    const resolved = await q<A>(sql`select id, rule_key, subject, title, resource_id, started_at, resolved_at from ops.alerts where resolved_at is not null`);
    const t = (d: Date | string) => new Date(d).getTime();

    // HighLatency: the two checks up to when it fired are slow, the one when it resolved is not, and the rollups show it.
    const latency = resolved.filter((x) => x.rule_key === "HighLatency");
    expect(latency).toHaveLength(2);
    for (const al of latency) {
      const around = await q<{ at: Date; latency_ms: number }>(sql`select at, latency_ms from ops.checks where monitor_id = ${al.subject}::uuid
        and at between ${new Date(t(al.started_at) - 9 * 60_000).toISOString()}::timestamptz and ${new Date(al.resolved_at!).toISOString()}::timestamptz order by at`);
      expect(around.length, al.title).toBeGreaterThanOrEqual(3);
      expect(around.slice(0, -1).every((c) => c.latency_ms > 1500), al.title).toBe(true);
      expect(around.at(-1)!.latency_ms, al.title).toBeLessThan(1500);
      expect(t(around.at(-1)!.at)).toBe(t(al.resolved_at!));
      const [hours] = await q<{ p95: number }>(sql`select max(p95_ms)::int as p95 from ops.rollups_hourly where monitor_id = ${al.subject}::uuid
        and hour between ${new Date(t(al.started_at) - 60 * 60_000).toISOString()}::timestamptz and ${new Date(al.resolved_at!).toISOString()}::timestamptz`);
      expect(hours.p95, al.title).toBeGreaterThan(1500);
    }

    // The rejected rollback was proposed after its alert started and turned down before it resolved.
    const [rejected] = await q<{ alert_id: string; created_at: Date; decided_at: Date }>(sql`select alert_id, created_at, decided_at from ops.action_proposals where status = 'rejected'`);
    const its = resolved.find((x) => x.id === rejected.alert_id)!;
    expect(t(rejected.created_at)).toBeGreaterThan(t(its.started_at));
    expect(t(rejected.decided_at)).toBeGreaterThan(t(rejected.created_at));
    expect(t(rejected.decided_at)).toBeLessThan(t(its.resolved_at!));

    // CredentialExpiring: the owner replaced the credential shortly before it resolved.
    const cred = resolved.find((x) => x.rule_key === "CredentialExpiring")!;
    const replaced = (await a.select().from(events).where(sql`type = 'action' and message = ${`Credential replaced: ${cred.title}`}`));
    expect(replaced).toHaveLength(1);
    expect(t(replaced[0].at)).toBeGreaterThan(t(cred.started_at));
    expect(t(replaced[0].at)).toBeLessThan(t(cred.resolved_at!));

    // DnsProxiedToVercel: the subject is a real record of that zone, to Vercel and DNS only now.
    const dns = resolved.find((x) => x.rule_key === "DnsProxiedToVercel")!;
    const [zone] = await a.select().from(snapshots).where(sql`resource_id = ${dns.resource_id}::uuid`);
    const record = (zone.data as { records: { id: string; name: string; content: string; proxied: boolean }[] }).records.find((r) => r.id === dns.subject);
    expect(record).toMatchObject({ name: dns.title, content: "76.76.21.21", proxied: false });
  });

  it("the seeded alerts agree with the real rules: evaluating now opens and resolves nothing", async () => {
    const b = await fresh(); // evaluating touches the open alerts, so not on the shared database
    await seedDemoDb(b, SEED, NOW, EMAIL);
    h.db = b;
    try {
      const before = await b.select().from(alerts).orderBy(asc(alerts.id));
      expect(await evaluateAlerts(NOW)).toEqual({ opened: 0, resolved: 0 });
      const after = await b.select().from(alerts).orderBy(asc(alerts.id));
      expect(after.map((x) => [x.id, x.resolvedAt])).toEqual(before.map((x) => [x.id, x.resolvedAt]));
    } finally {
      h.db = a;
    }
  }, 60_000);

  it("Events: deployments, the outage, network, daily runs and the owner's actions", async () => {
    const rows = await listEvents(200);
    const types = new Set(rows.map((e) => e.type));
    for (const t of ["deployment", "monitor", "system", "action"]) expect(types.has(t as never), t).toBe(true);
    expect(rows.some((e) => e.message === "Monitor down")).toBe(true);
    expect(rows.some((e) => e.message === "Monitor recovered")).toBe(true);
    expect(rows.filter((e) => e.type === "action").length).toBeGreaterThanOrEqual(5);
    expect((await listEvents(50, { excludeActions: true })).every((e) => e.type !== "action")).toBe(true);
  });

  it("Logs and Provider status", async () => {
    expect((await listStoredLogs(NOW)).length).toBeGreaterThan(5);
    const feeds = await listProviderStatus(NOW);
    expect(feeds).toHaveLength(6);
    expect(feeds.every((f) => f.state !== "unknown")).toBe(true);
  });

  it("Auto-actions and AI usage rows (private tables, written with SQL)", async () => {
    const props = await q<{ status: string; risk: string; auto: boolean; expires_at: Date }>(sql`select status, risk, auto, expires_at from ops.action_proposals order by created_at`);
    expect(props.map((p) => `${p.status}/${p.risk}${p.auto ? "/auto" : ""}`).sort()).toEqual(["done/safe/auto", "pending/risky", "pending/safe", "rejected/risky"]);
    for (const p of props.filter((x) => x.status === "pending")) expect(new Date(p.expires_at).getTime()).toBeGreaterThan(NOW.getTime());
    const [usage] = await q<{ n: number; recent: number }>(sql`select count(*)::int as n, (count(*) filter (where at > ${NOW.toISOString()}::timestamptz - interval '1 day'))::int as recent from ops.ai_usage`);
    expect(usage.n).toBeGreaterThanOrEqual(70);
    expect(usage.recent).toBeGreaterThan(0);
  });

  it("names nothing real: every host is under .example and no credential is stored", async () => {
    const all = JSON.stringify({
      resources: await a.select().from(resources), snapshots: await a.select().from(snapshots), alerts: await a.select().from(alerts),
      events: await a.select().from(events), logs: await a.select().from(storedLogs), proposals: await q(sql`select * from ops.action_proposals`),
    });
    expect(all).not.toMatch(/vercel\.app|github\.com|supabase\.co|neon\.tech|https?:\/\/(?![a-z0-9-]+\.example\/)/);
    const hosts = [...all.matchAll(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/g)].map((m) => m[1]).filter((x) => !/^\d/.test(x));
    const odd = hosts.filter((x) => !x.endsWith(".example") && !/\.(ts|tsx|js|json)$/.test(x) && !/^(gemini|workers-ai|pg)\b/.test(x));
    expect([...new Set(odd)]).toEqual([]);
    expect((await a.select().from(accounts)).every((x) => x.credentialCiphertext === "demo" && x.credentialIv === "demo")).toBe(true);
    expect((await a.select().from(supabaseMetricsKeys)).every((x) => x.keyCiphertext === "demo")).toBe(true);
  });

  it("is deterministic for a seed (the Task 5 tables too)", async () => {
    const again = await fresh();
    await seedDemoDb(again, SEED, NOW, EMAIL);
    const dump = async (d: Drizzle) => ({
      alerts: await d.select().from(alerts).orderBy(asc(alerts.id)),
      events: await d.select().from(events).orderBy(asc(events.id)),
      links: await d.select().from(links).orderBy(asc(links.id)),
      keep: await d.select().from(keepActive),
      metrics: await d.select().from(supabaseMetrics).orderBy(asc(supabaseMetrics.hour)),
      logs: await d.select().from(storedLogs).orderBy(asc(storedLogs.id)),
      status: await d.select().from(providerStatus).orderBy(asc(providerStatus.provider)),
      settings: await d.select().from(settings).where(sql`key <> 'advisor.latest'`).orderBy(asc(settings.key)), // the first view computes it
      proposals: rowsOf(await d.execute(sql`select * from ops.action_proposals order by id`)),
      usage: rowsOf(await d.execute(sql`select at, model, tokens_in, tokens_out, latency_ms, status from ops.ai_usage order by at, id`)),
    });
    expect(await dump(again)).toEqual(await dump(a));
  }, 60_000);
});
