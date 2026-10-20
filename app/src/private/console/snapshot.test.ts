import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAliasBook } from "@/lib/view/display-name";
import { problemsOf } from "@/lib/view/why";
import { LEAK_PATTERNS } from "./scrub";

const h = vi.hoisted(() => ({
  memos: [] as Map<string, unknown>[],
  listApps: vi.fn(), listMonitors: vi.fn(), listFiring: vi.fn(), listEvents: vi.fn(), listStoredLogs: vi.fn(), listDatabases: vi.fn(),
  listRecommendations: vi.fn(), aliasBook: vi.fn(),
}));
// React's cache only memoises inside a server render; here it is a per-test memo so "one read per request" is testable.
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  cache: <A extends unknown[], R>(fn: (...a: A) => R) => {
    const store = new Map<string, unknown>();
    h.memos.push(store);
    return (...a: A): R => {
      const k = JSON.stringify(a);
      if (!store.has(k)) store.set(k, fn(...a));
      return store.get(k) as R;
    };
  },
}));
vi.mock("@/lib/data/apps-db", () => ({ listApps: h.listApps }));
vi.mock("@/lib/data/monitors-db", () => ({ listMonitors: h.listMonitors }));
vi.mock("@/lib/data/alerts-db", () => ({ listFiring: h.listFiring }));
vi.mock("@/lib/data/events-db", () => ({ listEvents: h.listEvents }));
vi.mock("@/lib/data/logs-db", () => ({ listStoredLogs: h.listStoredLogs }));
vi.mock("@/lib/data/advisor-db", () => ({ listRecommendations: h.listRecommendations }));
vi.mock("@/lib/data/cached", () => ({ aliasBook: h.aliasBook, listDatabases: h.listDatabases }));

import { appDetail, consoleSnapshot, resolveApp, snapApps, snapDatabases, snapEvents, snapLogs, snapMonitors } from "./snapshot";

const now = new Date("2026-10-13T12:00:00Z");
const book = buildAliasBook(
  [
    { id: "app-1", kind: "app", name: "orbit-blog", firstSeenAt: "2026-01-01T00:00:00Z" },
    { id: "app-2", kind: "app", name: "acme-shop", firstSeenAt: "2026-01-02T00:00:00Z" },
    { id: "db-1", kind: "supabase_project", name: "atlas-main", firstSeenAt: "2026-01-03T00:00:00Z" },
  ],
  [{ id: "acc-1", label: "acme-personal", createdAt: "2026-01-01T00:00:00Z" }],
);

const mon = (o: Record<string, unknown> = {}) => ({
  id: "m1", appId: "app-1", url: "https://secret-host.example.com/", path: "/", state: "ok", lastStatus: 200, lastLatencyMs: 80, failStreak: 0,
  paused: false, ownerPaused: false, lastCheckedAt: now, expectedStatus: 200, timeoutMs: 5000, intervalS: 60, bodyContains: null, jsonPath: null,
  jsonEquals: null, lastError: null, kind: "http", name: null, periodS: null, graceS: null, lastPingAt: null, stateSince: null, maintUntil: null, ...o,
});
const app = (o: Record<string, unknown> = {}) => ({
  id: "app-1", name: "orbit-blog", gone: false, state: "err", stateSince: now, domain: "web.example.com", monitors: [mon({ state: "err", lastStatus: 502 })],
  lastDeploy: { state: "error", commitSha: "abc1234def", createdAt: new Date("2026-10-13T11:00:00Z"), readyAt: null, buildingAt: null },
  uptime30: 98.7123, days: new Map(), database: null, dbPaused: false, ...o,
});
const dbApp = app({
  id: "app-2", name: "acme-shop", state: "warn", monitors: [], dbPaused: true,
  lastDeploy: { state: "ready", commitSha: "1111111aaa", createdAt: new Date("2026-10-13T08:00:00Z"), readyAt: new Date("2026-10-13T08:02:00Z"), buildingAt: null },
  database: { id: "db-1", kind: "supabase_project", name: "atlas-main", externalId: "ref", account: "acme-personal", state: "paused" },
});

beforeEach(() => {
  vi.resetAllMocks();
  for (const m of h.memos) m.clear();
  h.aliasBook.mockResolvedValue(book);
  h.listApps.mockResolvedValue([app(), dbApp]);
  h.listMonitors.mockResolvedValue([]);
  h.listFiring.mockResolvedValue([]);
  h.listEvents.mockResolvedValue([]);
  h.listStoredLogs.mockResolvedValue([]);
  h.listDatabases.mockResolvedValue([]);
  h.listRecommendations.mockResolvedValue([]);
});

describe("appDetail", () => {
  it("returns the same problems as the app page's Why dialog, with the database by alias", async () => {
    const a = dbApp;
    const expected = problemsOf({ ...a, database: { id: "db-1", kind: "supabase_project", name: "db-a" } } as never, now);
    const d = await appDetail("acme-shop", now);
    expect(d).not.toBeNull();
    expect(d!.problems).toHaveLength(expected.length);
    expect(d!.problems.map((p) => [p.kind, p.where, p.what])).toEqual(expected.map((p) => [p.kind, p.where, p.reason]));
    expect(d!.problems[0].where).toBe("Database db-a");
    expect(d!.database).toBe("db-a");
    expect(d!.problems[0].fix).toBe(expected[0].remedies.join("; "));
    expect(JSON.stringify(d)).not.toContain("atlas-main");
  });
  it("finds an app by name (any case) or by console id, and answers null for an unknown one", async () => {
    expect((await appDetail("ORBIT-BLOG", now))?.id).toBe("orbit-blog");
    expect((await appDetail("app-2", now))?.id).toBe("acme-shop");
    expect(await appDetail("nope", now)).toBeNull();
    expect(await appDetail("   ", now)).toBeNull();
  });
  it("includes the app's monitors with their own 30-day uptime", async () => {
    const d = await appDetail("orbit-blog", now);
    expect(d!.state).toBe("down");
    expect(d!.monitors).toEqual([{ path: "/", kind: "http", state: "down", lastStatus: 502, latencyMs: 80, uptime30d: null }]);
  });
  it("skips an app that is gone from Vercel", async () => {
    h.listApps.mockResolvedValue([app({ gone: true })]);
    expect(await appDetail("orbit-blog", now)).toBeNull();
    expect(await snapApps(now)).toEqual([]);
  });
});

describe("resolveApp", () => {
  it("returns the AppSummary so callers can use its console id", async () => {
    expect((await resolveApp("Orbit-Blog", now))?.id).toBe("app-1");
  });
});

describe("consoleSnapshot", () => {
  it("maps app states and reads each section once", async () => {
    const s = await consoleSnapshot(now);
    expect(s.generatedAt).toBe("2026-10-13T12:00:00.000Z");
    expect(s.apps.map((a) => [a.id, a.state])).toEqual([["orbit-blog", "down"], ["acme-shop", "degraded"]]);
    expect(s.apps[0]).toMatchObject({ uptime30d: 98.71, database: null });
    expect(s.apps[0].lastDeploy).toMatch(/^abc1234 · failed/);
    expect(h.listApps).toHaveBeenCalledTimes(1);
    expect(h.listApps).toHaveBeenCalledWith(now);
  });
  it("reads only the sections asked for", async () => {
    const s = await consoleSnapshot(now, ["alerts"]);
    expect(h.listApps).not.toHaveBeenCalled();
    expect(h.listMonitors).not.toHaveBeenCalled();
    expect(h.listRecommendations).not.toHaveBeenCalled();
    expect(h.listFiring).toHaveBeenCalledTimes(1);
    expect(s.apps).toEqual([]);
    expect(s.advisor).toBeUndefined();
    expect(s.alerts).toMatchObject({ open: 0, critical: 0 });
  });
  it("counts monitors by state and lists only the ones that aren't up", async () => {
    h.listMonitors.mockResolvedValue([
      { ...mon({ id: "a" }), appName: "orbit-blog", appGone: false, uptime30: 100 },
      { ...mon({ id: "b", state: "err", lastStatus: 502 }), appName: "orbit-blog", appGone: false, uptime30: 97.5 },
      { ...mon({ id: "c", state: "warn" }), appName: "acme-shop", appGone: false, uptime30: 99 },
      { ...mon({ id: "d", paused: true }), appName: "acme-shop", appGone: false, uptime30: null },
      { ...mon({ id: "e", state: "err" }), appName: "old", appGone: true, uptime30: null },
    ]);
    const m = await snapMonitors(now);
    expect([m.up, m.degraded, m.down, m.paused]).toEqual([1, 1, 1, 1]);
    expect(m.items).toHaveLength(3);
  });
  it("answers the advisor by app name, 'console' for items without an app", async () => {
    h.listRecommendations.mockResolvedValue([
      { key: "k1", severity: "warning", appId: "app-1", subject: "orbit-blog", title: "Next.js 15 reaches end of life", why: "w", fix: "f", href: "/x" },
      { key: "k2", severity: "warning", appId: null, subject: "supabase · acme-personal", title: "Account acme-personal has no free slot", why: "w", fix: "f", href: "/supabase" },
    ]);
    const s = await consoleSnapshot(now, ["advisor"]);
    expect(s.advisor).toEqual([
      { title: "Next.js 15 reaches end of life", app: "orbit-blog", severity: "warning" },
      { title: "Account account-1 has no free slot", app: "console", severity: "warning" },
    ]);
  });
});

describe("leak test (R5)", () => {
  it("never lets names, hosts, emails, tokens or connection strings through any section", async () => {
    h.listApps.mockResolvedValue([
      app({ monitors: [mon({ state: "err", lastStatus: null, lastError: "getaddrinfo ENOTFOUND https://secret-host.example.com/x?key=1 owner@example.com" })] }),
      dbApp,
    ]);
    h.listMonitors.mockResolvedValue([{ ...mon({ state: "err", path: "/api/health", url: "https://secret-host.example.com/api/health" }), appName: "orbit-blog", appGone: false, uptime30: 90 }]);
    h.listFiring.mockResolvedValue([{
      id: "al", severity: "critical", title: "atlas-main is paused", message: "Database atlas-main (acme-personal) is paused, see https://supabase.com/dashboard/project/ref",
      causedBy: null, resourceId: "db-1", resourceName: "atlas-main", resourceKind: "supabase_project", startedAt: now,
    }]);
    h.listRecommendations.mockResolvedValue([{ key: "k", severity: "info", appId: "app-1", subject: "orbit-blog", title: "Rotate wp_" + "A".repeat(40), why: "w", fix: "f", href: "/" }]);
    h.listEvents.mockResolvedValue([{
      id: "e1", at: now, lastAt: null, count: 1, reason: null, type: "monitor", kind: "err", message: "orbit-blog down: owner@example.com", detail: "Authorization: Bearer abcdef postgres://u:p@h/db sk-" + "q".repeat(30),
      resource: "orbit-blog", resourceId: "app-1",
    }]);
    h.listStoredLogs.mockResolvedValue([{ id: "l1", at: now, level: "error", app: "orbit-blog", method: "GET", path: "/api/x", status: 500, message: "failed for owner@example.com hb_" + "0123456789abcdef".repeat(2) + " gsk_" + "k".repeat(30) + " AIza" + "z".repeat(35) }]);
    h.listDatabases.mockImplementation(async (kind: string) => (kind === "supabase_project"
      ? [{ id: "db-1", name: "atlas-main", kind, account: "acme-personal", state: "paused", stateSince: now, usedBy: [{ id: "app-2", name: "acme-shop" }], externalId: "ref", data: {} }] : []));

    const all = JSON.stringify({
      snapshot: await consoleSnapshot(now), detail: await appDetail("orbit-blog", now), events: await snapEvents(10), logs: await snapLogs(10, now),
      dbs: await snapDatabases(),
    });
    for (const p of LEAK_PATTERNS) expect(all, `leaks "${p}"`).not.toContain(p);
    for (const s of ["atlas-main", "acme-personal", "secret-host", "owner", "supabase.com"]) expect(all, `leaks "${s}"`).not.toContain(s);
    expect(all).toContain("db-a");
  });
});

describe("snapEvents / snapLogs / snapDatabases", () => {
  it("clamps the limit to 1..100", async () => {
    await snapEvents(5000);
    expect(h.listEvents).toHaveBeenLastCalledWith(100);
    await snapEvents(0);
    expect(h.listEvents).toHaveBeenLastCalledWith(1);
    await snapEvents(Number.NaN);
    expect(h.listEvents).toHaveBeenLastCalledWith(100);
  });
  it("returns the newest log lines first", async () => {
    const line = (id: string, min: number) => ({ id, at: new Date(now.getTime() - min * 60_000), level: "error", app: "orbit-blog", method: null, path: null, status: null, message: id });
    h.listStoredLogs.mockResolvedValue([line("old", 30), line("mid", 20), line("new", 10)]);
    expect((await snapLogs(2, now)).map((l) => l.message)).toEqual(["new", "mid"]);
  });
  it("lists databases by alias with their provider and users", async () => {
    h.listDatabases.mockImplementation(async (kind: string) => (kind === "supabase_project"
      ? [{ id: "db-1", name: "atlas-main", kind, account: "x", state: "paused", stateSince: null, usedBy: [{ id: "app-2", name: "acme-shop" }], externalId: "ref", data: {} }] : []));
    expect(await snapDatabases()).toEqual([{ name: "db-a", provider: "supabase", state: "paused", since: null, usedBy: ["acme-shop"] }]);
  });
});
