import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { collectorRuns } from "@/db/schema";
import { fakeDb, limitOf } from "./fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));

import { listApps, getApp } from "./apps-db";
import { listDeployments, ongoingBuilds, toDeployLite } from "./deployments-db";
import { listEvents } from "./events-db";
import { appMetrics, appResponse, health, monitorDays, rawChecksFrom, rolledUntil } from "./metrics-db";
import { listMonitors, toMonitorLite } from "./monitors-db";
import { brokenAccounts, lastMinuteRun } from "./overview-db";

const NOW = new Date("2026-10-12T05:00:00Z");
const use = (results: unknown[][]) => {
  const f = fakeDb(results);
  h.current = f;
  return f;
};

const monitorRow = (over: Record<string, unknown> = {}) => ({
  id: "m1", resourceId: "a1", url: "https://x.example.com/api/health?x=1", state: "up", lastStatus: 200, lastLatencyMs: 80,
  failStreak: 0, paused: false, ownerPaused: true, lastCheckedAt: null, expectedStatus: 200, timeoutMs: 10000, intervalS: 60, ...over,
});
const deployRow = (over: Record<string, unknown> = {}) => ({
  id: "d1", resourceId: "a1", state: "ready", target: "production", branch: "main", commitSha: "abcdef1234", commitMessage: "msg",
  url: "x.vercel.app", createdAtProvider: new Date("2026-10-12T04:00:00Z"), buildingAt: null, readyAt: null, isCurrent: true,
  isPreviousProduction: false, ...over,
});

beforeEach(() => {
  h.current = null;
});

describe("mappers", () => {
  it("toMonitorLite keeps the owner pause separate and derives the path", () => {
    const m = toMonitorLite(monitorRow() as never);
    expect(m).toMatchObject({ appId: "a1", path: expect.any(String), paused: false, ownerPaused: true });
    expect(m.path).not.toContain("example.com");
  });

  it("toMonitorLite carries the body rule and the last error for the edit dialog", () => {
    expect(toMonitorLite(monitorRow({ bodyContains: "ok", jsonPath: null, jsonEquals: null, lastError: "Keyword not found" }) as never)).toMatchObject({ bodyContains: "ok", jsonPath: null, jsonEquals: null, lastError: "Keyword not found" });
  });

  it("toDeployLite renames the provider creation time", () => {
    const d = toDeployLite(deployRow() as never);
    expect(d.createdAt).toEqual(new Date("2026-10-12T04:00:00Z"));
    expect(d).not.toHaveProperty("createdAtProvider");
  });
});

describe("metrics-db", () => {
  it("rolledUntil is the hour after the last rolled-up hour, or null", async () => {
    use([[{ h: new Date("2026-10-11T23:00:00Z") }]]);
    expect(await rolledUntil()).toEqual(new Date("2026-10-12T00:00:00Z"));
    use([[{ h: null }]]);
    expect(await rolledUntil()).toBeNull();
  });

  it("monitorDays, appResponse with nothing to look up never touch the database", async () => {
    const f = use([]);
    expect((await monitorDays([], NOW)).size).toBe(0);
    expect((await appResponse([], NOW)).size).toBe(0);
    expect(f.queries).toHaveLength(0);
  });

  it("monitorDays skips the rollup query before the first rollup and reads raw checks only", async () => {
    const f = use([[{ h: null }], [{ monitorId: "m1", day: "2026-10-12", checks: 10, failures: 1 }]]);
    const out = await monitorDays(["m1"], NOW);
    expect(f.queries).toHaveLength(2);
    expect(f.remaining()).toBe(0);
    expect(out.get("m1")?.get("2026-10-12")).toMatchObject({ checks: 10, failures: 1 });
  });

  it("monitorDays merges rolled-up and raw days", async () => {
    const f = use([
      [{ h: new Date("2026-10-11T23:00:00Z") }],
      [{ monitorId: "m1", day: "2026-10-11", checks: 100, failures: 2 }],
      [{ monitorId: "m1", day: "2026-10-12", checks: 5, failures: 0 }],
    ]);
    const out = await monitorDays(["m1"], NOW);
    expect(f.queries).toHaveLength(3);
    expect(f.remaining()).toBe(0);
    expect([...(out.get("m1")?.keys() ?? [])].sort()).toEqual(["2026-10-11", "2026-10-12"]);
  });

  it("rawChecksFrom starts at the end of the rollups, never earlier (no double count) and never before the window", () => {
    const since = new Date("2026-07-15T17:00:00Z");
    const until = new Date("2026-10-12T00:00:00Z");
    expect(rawChecksFrom(since, until, NOW)).toEqual(until);
    expect(rawChecksFrom(since, null, NOW)).toEqual(new Date(NOW.getTime() - 7 * 86_400_000));
    expect(rawChecksFrom(since, new Date("2026-09-01T00:00:00Z"), NOW)).toEqual(new Date(NOW.getTime() - 7 * 86_400_000));
    expect(rawChecksFrom(new Date("2026-10-11T17:00:00Z"), new Date("2026-10-10T00:00:00Z"), NOW)).toEqual(new Date("2026-10-11T17:00:00Z"));
  });

  it("monitorDays reads raw checks from rolledUntil when rollups exist", async () => {
    const f = use([[{ h: new Date("2026-10-11T23:00:00Z") }], [], []]);
    await monitorDays(["m1"], NOW);
    const where = f.queries[2].find((c) => c.method === "where")?.args[0] as SQL;
    expect(new PgDialect().sqlToQuery(where).params).toContain("2026-10-12T00:00:00.000Z");
  });

  it("monitorDays counts maintenance checks apart from checks and failures, in raw checks and rollups (U5)", async () => {
    const f = use([
      [{ h: new Date("2026-10-11T23:00:00Z") }],
      [{ monitorId: "m1", day: "2026-10-11", checks: 100, failures: 0, maint: 60 }],
      [{ monitorId: "m1", day: "2026-10-12", checks: 0, failures: 0, maint: 5 }],
    ]);
    const out = await monitorDays(["m1"], NOW);
    expect(f.remaining()).toBe(0);
    // review M3: the raw-check SQL itself splits maintenance checks out (queries: rolledUntil, rollups, raw checks).
    const field = (q: number, name: string) => new PgDialect().sqlToQuery((f.queries[q].find((c) => c.method === "select")?.args[0] as Record<string, SQL>)[name]).sql;
    expect(field(1, "maint")).toMatch(/sum\("ops"."rollups_hourly"."maintenance"\)/);
    expect(field(2, "checks")).toMatch(/count\(\*\) filter \(where not "ops"."checks"."in_maintenance"\)/);
    expect(field(2, "failures")).toMatch(/filter \(where not "ops"."checks"."ok" and not "ops"."checks"."in_maintenance"\)/);
    expect(field(2, "maint")).toMatch(/count\(\*\) filter \(where "ops"."checks"."in_maintenance"\)/);
    expect(out.get("m1")?.get("2026-10-11")).toEqual({ day: "2026-10-11", checks: 100, failures: 0, maint: 60 });
    expect(out.get("m1")?.get("2026-10-12")).toEqual({ day: "2026-10-12", checks: 0, failures: 0, maint: 5 });
  });

  it("health, appResponse and appMetrics leave maintenance checks out of every number (U5)", async () => {
    const outside = (calls: { method: string; args: unknown[] }[]) => {
      const q = new PgDialect().sqlToQuery(calls.find((c) => c.method === "where")?.args[0] as SQL);
      return /"in_maintenance" = \$\d+/.test(q.sql) && q.params.includes(false);
    };
    let f = use([[], [{ checks: 0, failures: 0, s5xx: 0, p95: null }], []]);
    await health(NOW);
    expect([outside(f.queries[0]), outside(f.queries[1])]).toEqual([true, true]);
    f = use([[], []]);
    await appResponse(["a1"], NOW);
    expect(f.queries.map(outside)).toEqual([true, true]);
    f = use([[]]);
    await appMetrics("a1", NOW);
    expect(outside(f.queries[0])).toBe(true);
  });

  it("appResponse returns 24 hourly slots and an empty entry for apps without checks", async () => {
    use([[], []]);
    const out = await appResponse(["a1"], NOW);
    expect(out.get("a1")?.hourly).toHaveLength(24);
    expect(out.get("a1")?.p95).toBeNull();
  });

  it("appMetrics returns 48 points, errors filled with 0", async () => {
    use([[]]);
    const out = await appMetrics("a1", NOW);
    expect(out.response).toHaveLength(48);
    expect(out.response.every((v) => v === null)).toBe(true);
    expect(out.errors.every((v) => v === 0)).toBe(true);
  });

  it("health is empty-safe: null uptime and p95, zero counts, 30 points", async () => {
    use([[], [{ checks: 0, failures: 0, s5xx: 0, p95: null }], []]);
    const out = await health(NOW);
    expect(out).toMatchObject({ uptime: null, p95: null, s5xx: 0, deploys: 0 });
    expect(out.series.uptime).toHaveLength(30);
    expect(out.series.deploys.every((v) => v === 0)).toBe(true);
  });

  it("health computes uptime from the totals and sums deployments", async () => {
    use([[], [{ checks: 200, failures: 2, s5xx: 3, p95: 120 }], [{ t: 0, n: 2 }, { t: 1, n: 1 }]]);
    const out = await health(NOW);
    expect(out.uptime).toBeCloseTo(99);
    expect(out).toMatchObject({ p95: 120, s5xx: 3, deploys: 3 });
  });
});

describe("monitors-db", () => {
  it("lists monitors with a 200 row cap and 30-day uptime from the day counts", async () => {
    const f = use([
      [{ m: monitorRow(), appName: "web" }],
      [{ h: null }],
      [{ monitorId: "m1", day: "2026-10-12", checks: 100, failures: 1 }],
    ]);
    const rows = await listMonitors(NOW);
    expect(limitOf(f.queries[0])).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ appName: "web", ownerPaused: true });
    expect(rows[0].uptime30).toBeCloseTo(99);
  });

  it("marks a monitor whose app is gone from Vercel (M5)", async () => {
    use([[{ m: monitorRow(), appName: "web", goneAt: new Date("2026-10-01T00:00:00Z") }, { m: monitorRow({ id: "m2" }), appName: "web", goneAt: null }], [{ h: null }], []]);
    const rows = await listMonitors(NOW);
    expect(rows.map((r) => r.appGone)).toEqual([true, false]);
  });

  it("gives a monitor without any checks a null uptime", async () => {
    use([[{ m: monitorRow(), appName: "web" }], [{ h: null }], []]);
    const [row] = await listMonitors(NOW);
    expect(row.uptime30).toBeNull();
    expect(row.days).toBeUndefined();
  });
});

describe("deployments-db", () => {
  it("lists newest first with a 200 row cap", async () => {
    const f = use([[{ d: deployRow(), appName: "web" }]]);
    const rows = await listDeployments({ appId: "a1" });
    expect(limitOf(f.queries[0])).toBe(200);
    expect(rows[0]).toMatchObject({ appId: "a1", appName: "web", id: "d1" });
  });

  it("caps ongoing builds at 5", async () => {
    const f = use([[]]);
    expect(await ongoingBuilds(NOW)).toEqual([]);
    expect(limitOf(f.queries[0])).toBe(5);
  });
});

describe("apps-db", () => {
  it("returns nothing, with a single query, when no app is watched", async () => {
    const f = use([[]]);
    expect(await listApps(NOW)).toEqual([]);
    expect(f.queries).toHaveLength(1);
    expect(limitOf(f.queries[0])).toBe(200);
    use([[]]);
    expect(await getApp("a1", NOW)).toBeNull();
  });

  it("builds a summary: domain from monitors, meta strings, default state and response", async () => {
    const f = use([
      [{
        r: { id: "a1", name: "web", goneAt: null, meta: { framework: "nextjs", productionBranch: "main", createdAt: "2026-01-02T00:00:00Z", teamName: "me" } },
        s: null,
      }],
      [monitorRow({ url: "https://portfolio.example.com/" })],
      [deployRow()],
      [{ h: null }],
      [{ monitorId: "m1", day: "2026-10-12", checks: 50, failures: 0 }],
      [],
      [],
    ]);
    const [app] = await listApps(NOW);
    expect(f.remaining()).toBe(0);
    expect(limitOf(f.queries[1])).toBe(200);
    expect(app).toMatchObject({
      id: "a1", gone: false, state: "unknown", stateSince: null, domain: "portfolio.example.com",
      framework: "nextjs", productionBranch: "main", teamName: "me",
    });
    expect(app.createdAt).toEqual(new Date("2026-01-02T00:00:00Z"));
    expect(app.monitors).toHaveLength(1);
    expect(app.lastDeploy?.id).toBe("d1");
    expect(app.uptime30).toBe(100);
    expect(app.response.hourly).toHaveLength(24);
  });

  it("gives each app only its own monitors' days", async () => {
    use([
      [
        { r: { id: "a1", name: "web", goneAt: null, meta: {} }, s: null },
        { r: { id: "a2", name: "api", goneAt: null, meta: {} }, s: null },
      ],
      [monitorRow(), monitorRow({ id: "m2", resourceId: "a2" })],
      [],
      [{ h: null }],
      [
        { monitorId: "m1", day: "2026-10-12", checks: 10, failures: 0 },
        { monitorId: "m2", day: "2026-10-12", checks: 20, failures: 0 },
      ],
      [],
      [],
    ]);
    const apps = await listApps(NOW);
    expect([...apps[0].days.keys()]).toEqual(["m1"]);
    expect([...apps[1].days.keys()]).toEqual(["m2"]);
  });

  it("marks a gone app and tolerates missing meta", async () => {
    const f = use([
      [{ r: { id: "a1", name: "web", goneAt: new Date(), meta: {} }, s: { state: "down", stateSince: NOW, data: {} } }],
      [],
      [],
      [],
      [],
    ]);
    const [app] = await listApps(NOW);
    expect(f.remaining()).toBe(0);
    expect(app).toMatchObject({ gone: true, state: "down", framework: null, createdAt: null, lastDeploy: null, uptime30: null, domain: "web.vercel.app" });
  });

  it("carries the Next.js security row from the same query, null before the first check", async () => {
    const at = new Date("2026-10-11T20:00:00Z");
    const findings = [{ id: "GHSA-f82v-jwr5-mffw", cve: "CVE-2025-29927", summary: "s", severity: "CRITICAL", fixed: "15.2.3" }];
    const f = use([
      [
        { r: { id: "a1", name: "web", goneAt: null, meta: {} }, s: null, sec: { resourceId: "a1", framework: "next", version: "15.1.0", status: "vulnerable", findings, reason: null, checkedAt: at } },
        { r: { id: "a2", name: "api", goneAt: null, meta: {} }, s: null, sec: null },
      ],
      [], [], [], [], [], [],
    ]);
    const [a, b] = await listApps(NOW);
    expect(a.security).toEqual({ version: "15.1.0", status: "vulnerable", findings, reason: null, checkedAt: at });
    expect(b.security).toBeNull();
    expect(f.queries[0].some((c) => c.method === "leftJoin" && c.args.length === 2)).toBe(true);
  });
});

describe("events-db", () => {
  const ev = (over: Record<string, unknown>) => ({ id: "e1", at: NOW, type: "status", kind: "up", message: "m", detail: null, ...over });

  it("never reads more than 200 rows, whatever limit is asked for", async () => {
    const f = use([[]]);
    await listEvents(5000);
    expect(limitOf(f.queries[0])).toBe(200);
    const g = use([[]]);
    await listEvents(5);
    expect(limitOf(g.queries[0])).toBe(5);
  });

  it("still bounds the read for NaN, negative, zero or fractional limits", async () => {
    for (const [ask, want] of [[Number.NaN, 200], [-3, 1], [0, 1], [Infinity, 200], [7.9, 7]] as const) {
      const f = use([[]]);
      await listEvents(ask);
      expect(limitOf(f.queries[0])).toBe(want);
    }
  });

  it("can leave out action events (Overview's recent five), and reads everything by default (M4)", async () => {
    const sqlOf = (q: { method: string; args: unknown[] }[]) => {
      const where = q.find((c) => c.method === "where")?.args[0] as SQL | undefined;
      return where ? new PgDialect().sqlToQuery(where) : null;
    };
    const f = use([[]]);
    await listEvents(5, { excludeActions: true });
    const q = sqlOf(f.queries[0]);
    expect(q?.sql).toMatch(/"type" <> \$1/);
    expect(q?.params).toEqual(["action"]);
    expect(limitOf(f.queries[0])).toBe(5);
    const g = use([[]]);
    await listEvents(5);
    expect(sqlOf(g.queries[0])).toBeNull();
  });

  it("carries the repeat count, last occurrence and reason, and orders by the latest occurrence (R2)", async () => {
    const last = new Date("2026-10-12T05:30:00Z");
    const f = use([[{ e: ev({ count: 4, lastAt: last, reason: "MonitorDown", resourceId: "r1" }), name: "web" }, { e: ev({ id: "e2" }), name: "web" }]]);
    const rows = await listEvents();
    expect(rows[0]).toMatchObject({ count: 4, lastAt: last, reason: "MonitorDown", resourceId: "r1" });
    expect(rows[1]).toMatchObject({ count: 1, lastAt: null, reason: null, resourceId: null });
    const order = f.queries[0].find((c) => c.method === "orderBy")?.args[0] as SQL;
    expect(new PgDialect().sqlToQuery(order).sql).toContain('coalesce("ops"."events"."last_at", "ops"."events"."at") desc');
  });

  it("names the source of events without a resource", async () => {
    use([[{ e: ev({}), name: "web" }, { e: ev({ id: "e2", type: "system" }), name: null }, { e: ev({ id: "e3", type: "action" }), name: null }]]);
    const rows = await listEvents();
    expect(rows.map((r) => r.resource)).toEqual(["web", "collector", "console"]);
  });
});

describe("overview-db", () => {
  it("lastMinuteRun is null without a finished run", async () => {
    use([[]]);
    expect(await lastMinuteRun()).toBeNull();
    use([[{ finishedAt: null, durationMs: null, checks: 0 }]]);
    expect(await lastMinuteRun()).toBeNull();
  });

  it("lastMinuteRun returns the newest finished run", async () => {
    const f = use([[{ finishedAt: NOW, durationMs: 1200, checks: 7 }]]);
    expect(await lastMinuteRun()).toEqual({ finishedAt: NOW, durationMs: 1200, checks: 7 });
    expect(limitOf(f.queries[0])).toBe(1);
  });

  it("lastMinuteRun orders by started_at (the indexed column)", async () => {
    const f = use([[]]);
    await lastMinuteRun();
    const order = f.queries[0].find((c) => c.method === "orderBy")?.args[0] as { queryChunks: unknown[] };
    expect(order.queryChunks).toContain(collectorRuns.startedAt);
    expect(order.queryChunks).not.toContain(collectorRuns.finishedAt);
  });

  it("brokenAccounts is capped at 50", async () => {
    const f = use([[{ provider: "vercel", label: "main" }]]);
    expect(await brokenAccounts()).toEqual([{ provider: "vercel", label: "main" }]);
    expect(limitOf(f.queries[0])).toBe(50);
  });
});
