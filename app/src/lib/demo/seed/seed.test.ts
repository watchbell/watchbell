import { PGlite } from "@electric-sql/pglite";
import { asc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import { rowsOf } from "@/db/rows";
import * as schema from "@/db/schema";
import { accounts, deployments, members, monitors, resources, rollupsHourly, snapshots } from "@/db/schema";

// The real page loaders read through db(); here it is the seeded in-memory PGlite.
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));

import { listApps } from "@/lib/data/apps-db";
import { listDeployments, ongoingBuilds } from "@/lib/data/deployments-db";
import { health } from "@/lib/data/metrics-db";
import { listMonitors } from "@/lib/data/monitors-db";
import { brokenAccounts, lastMinuteRun } from "@/lib/data/overview-db";
import { seedDemoDb } from "./index";

type Drizzle = ReturnType<typeof drizzle<typeof schema>>;
const NOW = new Date("2026-10-19T05:03:27.000Z");
const SEED_A = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const SEED_B = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const EMAIL = "visitor@example.com";

const opened: PGlite[] = [];
async function fresh(): Promise<Drizzle> {
  const client = await PGlite.create();
  opened.push(client);
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  return db;
}

// Everything the seed writes, as plain comparable values (checks summarised: there are thousands).
async function dump(db: Drizzle) {
  const q = <T>(s: ReturnType<typeof sql>) => db.execute(s).then((r) => rowsOf<T>(r));
  const [checkSum] = await q<{ n: number; fails: number; lat: number; digest: string }>(sql`
    select count(*)::int as n, (count(*) filter (where not ok))::int as fails, coalesce(sum(latency_ms), 0)::int as lat,
      md5(string_agg(id::text || at::text || ok::text || coalesce(status_code, 0)::text || coalesce(latency_ms, 0)::text, ',' order by id)) as digest
    from ops.checks`);
  return {
    members: await db.select().from(members).orderBy(asc(members.id)),
    accounts: await db.select().from(accounts).orderBy(asc(accounts.id)),
    resources: await db.select().from(resources).orderBy(asc(resources.id)),
    snapshots: await db.select().from(snapshots).orderBy(asc(snapshots.resourceId)),
    monitors: await db.select().from(monitors).orderBy(asc(monitors.id)),
    deployments: await db.select().from(deployments).orderBy(asc(deployments.id)),
    rollups: await db.select().from(rollupsHourly).orderBy(asc(rollupsHourly.monitorId), asc(rollupsHourly.hour)),
    checkSum,
  };
}

let a: Drizzle;
let seedMs = 0;

beforeAll(async () => {
  a = await fresh();
  const t0 = performance.now();
  await seedDemoDb(a, SEED_A, NOW, EMAIL);
  seedMs = performance.now() - t0;
  h.db = a;
}, 120_000);

afterAll(async () => {
  await Promise.all(opened.map((c) => c.close().catch(() => undefined)));
});

describe("seedDemoDb: apps, deployments and uptime", () => {
  // A loose wall-clock guard against a runaway seed (about 1 s on a laptop); the 3 s per-instance budget is the pool's.
  it("seeds in well under 10 s", () => {
    expect(seedMs).toBeLessThan(10_000);
  });

  // The pool seeds without foreign-key checks (they were half its time); every row the seed writes must still point at
  // one that exists, for both seeds this file uses.
  it("writes only rows whose foreign keys hold", async () => {
    const checkedA = await fresh();
    await seedDemoDb(checkedA, SEED_A, NOW, EMAIL, { foreignKeyChecks: true });
    expect(await dump(checkedA)).toEqual(await dump(a)); // and the same rows as the unchecked seed
    await expect(seedDemoDb(await fresh(), SEED_B, NOW, EMAIL, { foreignKeyChecks: true })).resolves.toBeUndefined();
  }, 120_000);

  it("makes the visitor the only member, an owner, with a stable user id", async () => {
    const rows = await a.select().from(members);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: EMAIL, role: "owner" });
    expect(rows[0].userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // The owner was there before every account and app.
    const firsts = [...(await a.select().from(accounts)), ...(await a.select().from(resources))].map((r) => r.createdAt.getTime());
    expect(rows[0].createdAt.getTime()).toBeLessThan(Math.min(...firsts));
  });

  it("uses only reserved .example hosts and a made-up repository organisation, never a real site", async () => {
    const isExample = (host: string) => /^[a-z0-9-]+\.example$/.test(host);
    for (const m of await a.select().from(monitors)) expect(isExample(new URL(m.url).host), m.url).toBe(true);
    for (const d of await a.select().from(deployments)) {
      expect(isExample(d.url!), d.url!).toBe(true);
      expect(d.url).toMatch(/-git-[a-z0-9-]+-[a-z0-9]{9}\.example$/);
    }
    for (const r of await a.select().from(resources).where(sql`kind = 'app'`)) expect(r.meta.repo).toBe(`example-org/${r.name}`);
    expect(JSON.stringify(await dump(a))).not.toMatch(/vercel\.app|github\.com|https?:\/\/(?![a-z0-9-]+\.example\/)/);
  });

  it("has 5-8 watched apps, each with 1-2 HTTP monitors and 7 days of 5-minute checks", async () => {
    const apps = await a.select().from(resources).where(sql`kind = 'app'`);
    expect(apps.length).toBeGreaterThanOrEqual(5);
    expect(apps.length).toBeLessThanOrEqual(8);
    expect(apps.every((r) => r.monitored && r.goneAt === null)).toBe(true);
    expect(new Set(apps.map((r) => r.name)).size).toBe(apps.length);
    for (const r of apps) expect(r.meta).toMatchObject({ teamId: expect.any(String), framework: expect.any(String), productionBranch: "main" });

    const mons = await a.select().from(monitors);
    for (const app of apps) {
      const own = mons.filter((m) => m.resourceId === app.id);
      expect(own.length).toBeGreaterThanOrEqual(1);
      expect(own.length).toBeLessThanOrEqual(2);
    }
    expect(mons.every((m) => m.kind === "http" && m.intervalS === 300 && m.lastCheckedAt !== null)).toBe(true);

    const perMonitor = rowsOf<{ n: number; first: Date; last: Date }>(await a.execute(sql`
      select count(*)::int as n, min(at) as first, max(at) as last from ops.checks group by monitor_id`));
    expect(perMonitor).toHaveLength(mons.length);
    for (const p of perMonitor) {
      expect(p.n).toBe(7 * 288);
      expect(NOW.getTime() - new Date(p.last).getTime()).toBeLessThan(5 * 60_000 + 10_000); // one 5-minute slot
      expect(new Date(p.last).getTime()).toBeLessThanOrEqual(NOW.getTime());
      expect(NOW.getTime() - new Date(p.first).getTime()).toBeLessThanOrEqual(7 * 86_400_000);
    }
  });

  it("keeps the monitor row in step with its latest check", async () => {
    const latest = rowsOf<{ monitor_id: string; at: Date; ok: boolean; status_code: number | null; latency_ms: number | null; error: string | null }>(await a.execute(sql`
      select distinct on (monitor_id) monitor_id, at, ok, status_code, latency_ms, error from ops.checks order by monitor_id, at desc`));
    const mons = await a.select().from(monitors);
    for (const m of mons) {
      const c = latest.find((l) => l.monitor_id === m.id)!;
      expect(m.lastCheckedAt!.getTime()).toBe(new Date(c.at).getTime());
      expect(m.lastStatus).toBe(c.status_code);
      expect(m.lastLatencyMs).toBe(c.latency_ms);
      expect(m.lastError).toBe(c.error);
      expect(m.state).toBe(c.ok ? "ok" : m.failStreak >= 3 ? "err" : "warn");
    }
    // One monitor is degraded right now (its latest check timed out); the rest are up.
    const degraded = mons.filter((m) => m.state !== "ok");
    expect(degraded.map((m) => [m.state, m.failStreak, m.lastError])).toEqual([["warn", 1, "No answer within 5 s"]]);
  });

  it("has a short outage: one monitor failing several checks in a row within the last day, then recovering", async () => {
    const runs = rowsOf<{ monitor_id: string; n: number; started: Date; ended: Date }>(await a.execute(sql`
      with c as (
        select monitor_id, at, ok, row_number() over (partition by monitor_id order by at)
          - row_number() over (partition by monitor_id, ok order by at) as grp
        from ops.checks
      )
      select monitor_id, count(*)::int as n, min(at) as started, max(at) as ended from c where not ok
      group by monitor_id, grp having count(*) >= 3`));
    expect(runs).toHaveLength(1);
    const [o] = runs;
    expect(o.n).toBeGreaterThanOrEqual(3);
    expect(o.n).toBeLessThanOrEqual(12);
    expect(NOW.getTime() - new Date(o.started).getTime()).toBeLessThan(24 * 3_600_000);
    const [m] = await a.select().from(monitors).where(sql`id = ${o.monitor_id}`);
    expect(m.state).toBe("ok"); // recovered
    expect(m.stateSince.getTime()).toBeGreaterThan(new Date(o.ended).getTime());
  });

  it("rolls up the hours before the last daily run, matching the raw checks where both exist", async () => {
    const [{ until }] = rowsOf<{ until: Date }>(await a.execute(sql`select max(hour) + interval '1 hour' as until from ops.rollups_hourly`));
    expect(new Date(until).getTime()).toBeLessThanOrEqual(NOW.getTime());
    const mismatched = rowsOf<{ n: number }>(await a.execute(sql`
      select count(*)::int as n from ops.rollups_hourly r
      join (select monitor_id, date_trunc('hour', at) as hour, count(*)::int as checks, (count(*) filter (where not ok))::int as failures
            from ops.checks group by 1, 2) c on c.monitor_id = r.monitor_id and c.hour = r.hour
      where c.hour > (select min(at) from ops.checks) and (c.checks <> r.checks or c.failures <> r.failures)`));
    expect(mismatched[0].n).toBe(0);
    const [{ oldest }] = rowsOf<{ oldest: Date }>(await a.execute(sql`select min(hour) as oldest from ops.rollups_hourly`));
    expect(NOW.getTime() - new Date(oldest).getTime()).toBeGreaterThan(29 * 86_400_000);
  });

  it("has recent deployments: exactly one failed, one building, a current and a previous production per app", async () => {
    const deps = await a.select().from(deployments);
    const apps = await a.select().from(resources).where(sql`kind = 'app'`);
    expect(deps.filter((d) => d.state === "error")).toHaveLength(1);
    const building = deps.filter((d) => d.state === "building");
    expect(building).toHaveLength(1);
    expect(NOW.getTime() - building[0].createdAtProvider.getTime()).toBeLessThan(3_600_000);
    for (const app of apps) {
      const own = deps.filter((d) => d.resourceId === app.id);
      expect(own.filter((d) => d.isCurrent)).toHaveLength(1);
      expect(own.filter((d) => d.isPreviousProduction)).toHaveLength(1);
      const current = own.find((d) => d.isCurrent)!;
      expect(current).toMatchObject({ state: "ready", target: "production" });
      const newerReadyProd = own.filter((d) => d.state === "ready" && d.target === "production" && d.createdAtProvider > current.createdAtProvider);
      expect(newerReadyProd).toHaveLength(0);
    }
    expect(deps.every((d) => d.createdAtProvider.getTime() <= NOW.getTime() && /^dpl_[A-Za-z0-9]{24}$/.test(d.externalId))).toBe(true);
  });

  it("feeds the real Overview, Applications, Uptime and Deployments loaders", async () => {
    const apps = await listApps(NOW);
    expect(apps.length).toBeGreaterThanOrEqual(5);
    for (const app of apps) {
      expect(app.monitors.length).toBeGreaterThan(0);
      expect(app.lastDeploy).not.toBeNull();
      expect(app.uptime30).not.toBeNull();
      expect(app.response.p95).not.toBeNull();
      expect(app.state).not.toBe("unknown");
      expect(app.pageViews).toMatchObject({ enabled: true });
    }

    const mons = await listMonitors(NOW);
    expect(mons.length).toBeGreaterThanOrEqual(apps.length);
    for (const m of mons) {
      expect(m.days?.size).toBeGreaterThanOrEqual(30);
      expect(m.uptime30).toBeGreaterThan(95);
    }

    const h24 = await health(NOW);
    expect(h24.uptime).not.toBeNull();
    expect(h24.uptime!).toBeLessThan(100); // the outage is inside the last 24 h
    expect(h24.s5xx).toBeGreaterThan(0);
    expect(h24.series.uptime.filter((v) => v !== null).length).toBeGreaterThan(25);

    expect((await listDeployments()).length).toBeGreaterThan(0);
    expect(await ongoingBuilds(NOW)).toHaveLength(1);
    const run = await lastMinuteRun();
    expect(run).not.toBeNull();
    expect(NOW.getTime() - run!.finishedAt.getTime()).toBeLessThan(5 * 60_000);
    expect(await brokenAccounts()).toEqual([]);
  });

  it("is deterministic for a seed and differs between seeds", async () => {
    const again = await fresh();
    await seedDemoDb(again, SEED_A, NOW, EMAIL);
    expect(await dump(again)).toEqual(await dump(a));

    const other = await fresh();
    await seedDemoDb(other, SEED_B, NOW, EMAIL);
    const x = await dump(a);
    const y = await dump(other);
    expect(y.members[0].userId).not.toBe(x.members[0].userId);
    expect(y.resources.map((r) => r.id)).not.toEqual(x.resources.map((r) => r.id));
    expect(y.checkSum.digest).not.toBe(x.checkSum.digest);
    expect(y.resources.filter((r) => r.kind === "app").map((r) => r.name).sort())
      .not.toEqual(x.resources.filter((r) => r.kind === "app").map((r) => r.name).sort());
  }, 60_000);

  it("keeps ids stable when the same seed is re-created later (an evicted visitor's links still work)", async () => {
    const later = await fresh();
    await seedDemoDb(later, SEED_A, new Date(NOW.getTime() + 47 * 60_000), EMAIL);
    const x = await dump(a);
    const y = await dump(later);
    expect(y.resources.map((r) => [r.id, r.name])).toEqual(x.resources.map((r) => [r.id, r.name]));
    expect(y.monitors.map((m) => [m.id, m.url])).toEqual(x.monitors.map((m) => [m.id, m.url]));
    expect(y.deployments.map((d) => [d.id, d.externalId])).toEqual(x.deployments.map((d) => [d.id, d.externalId]));
    expect(y.members[0].userId).toBe(x.members[0].userId);
  }, 60_000);
});
