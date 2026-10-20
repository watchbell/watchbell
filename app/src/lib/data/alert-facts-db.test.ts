import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, limitOf } from "./fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
// Stage 12: the compute facts have their own tests (supabase-metrics-db.test.ts).
vi.mock("@/lib/data/supabase-metrics-db", () => ({ computeFacts: async () => null }));

import { loadFacts } from "./alert-facts-db";

const now = new Date("2026-10-13T12:00:00Z");
const monitor = (over: Record<string, unknown> = {}) => ({
  id: "m1", resourceId: "a1", url: "https://web.example.com/", state: "ok", failStreak: 0, lastStatus: 200, lastCheckedAt: now, ...over,
});

beforeEach(() => { h.current = null; });

// Reads in order: last minute run, last run of any scheduler, monitors, apps, accounts, [check aggregate], [latest deployments], snapshots.
describe("loadFacts", () => {
  it("reports sources that have no data yet as null, not empty (S1)", async () => {
    h.current = fakeDb([[], [], [], [], [], []]);
    const f = await loadFacts(now);
    expect(f).toMatchObject({ lastAnyRunAt: null, dbs: null, domains: null, dns: null, links: [], monitors: [], apps: [], lastMinuteRunAt: null });
  });

  it("maps monitors with their last-10-minute latency, apps with their latest production deployment", async () => {
    const created = new Date("2026-10-13T11:00:00Z");
    h.current = fakeDb([
      [{ at: new Date("2026-10-13T11:59:00Z") }],
      [{ at: new Date("2026-10-13T11:59:30Z") }],
      [{ m: monitor(), appName: "web" }],
      [{ id: "a1", name: "web" }],
      [{ id: "c1", provider: "vercel", label: "acme", expiresAt: null, status: "ok", lastError: null }],
      [{ id: "m1", n: 10, p95: 1800 }],
      [{ appId: "a1", state: "error", sha: "0d3c8aa1", createdAt: created }],
      [],
    ]);
    const f = await loadFacts(now);
    expect(f.monitors).toEqual([expect.objectContaining({ id: "m1", appId: "a1", appName: "web", kind: "http", p95Last10: 1800, checksLast10: 10 })]);
    expect(f.apps).toEqual([{ id: "a1", name: "web", latestProduction: { state: "error", sha: "0d3c8aa1", createdAt: created } }]);
    expect(f.accounts).toHaveLength(1);
    expect(f.lastMinuteRunAt).toEqual(new Date("2026-10-13T11:59:00Z"));
    expect(f.lastAnyRunAt).toEqual(new Date("2026-10-13T11:59:30Z"));
  });

  it("passes a heartbeat on as kind heartbeat, named after the job (U3)", async () => {
    h.current = fakeDb([
      [], [],
      [{ m: monitor({ kind: "heartbeat", name: "backup job", url: "heartbeat:backup-job", state: "err", failStreak: 3, lastStatus: null }), appName: "web" }],
      [], [], [], [],
    ]);
    const f = await loadFacts(now);
    expect(f.monitors).toEqual([expect.objectContaining({ id: "m1", kind: "heartbeat", url: "backup job", state: "err" })]);
  });

  it("leaves checks made inside a maintenance window out of the 10-minute latency (U5)", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const fake = fakeDb([[], [], [{ m: monitor(), appName: "web" }], [], [], [], []]);
    h.current = fake;
    await loadFacts(now);
    const where = new PgDialect().sqlToQuery(fake.queries[5].find((c) => c.method === "where")?.args[0] as never);
    expect(where.sql).toMatch(/"in_maintenance" = \$\d+/);
    expect(where.params).toContain(false);
  });

  it("builds database, domain and DNS facts from stage 3 and 4 snapshots", async () => {
    h.current = fakeDb([
      [], [], [], [], [],
      [
        { id: "s1", name: "quillpad", kind: "supabase_project", state: "paused", data: { status: "INACTIVE", sizeBytes: 450e6 } },
        { id: "z1", name: "example.com", kind: "zone", state: "ok", data: {
          rdap: { expiresAt: "2026-11-01T00:00:00Z", registrar: "Cloudflare", error: null, checkedAt: "2026-10-13T00:00:00Z" },
          records: [{ id: "rec-1", type: "CNAME", name: "a.example.com", content: "cname.vercel-dns.com", proxied: true, ttl: 1, comment: null }],
        } },
        { id: "d1", name: "a.example.com", kind: "domain", state: "ok", data: {
          tls: { notAfter: "2026-10-20T00:00:00Z", issuer: "R11", authorized: true, error: null, checkedAt: "2026-10-13T00:00:00Z" },
        } },
      ],
      [],
    ]);
    const f = await loadFacts(now);
    expect(f.dbs).toEqual([expect.objectContaining({ id: "s1", provider: "supabase", state: "paused", sizeBytes: 450e6 })]);
    expect(f.domains).toEqual([
      { id: "z1", name: "example.com", tlsNotAfter: null, expiresAt: new Date("2026-11-01T00:00:00Z") },
      { id: "d1", name: "a.example.com", tlsNotAfter: new Date("2026-10-20T00:00:00Z"), expiresAt: null },
    ]);
    expect(f.dns).toEqual([{ id: "z1:rec-1", resourceId: "d1", name: "a.example.com", proxied: true, pointsToVercel: true }]);
  });

  it("reads app-to-database links from stage 3's links table, bounded", async () => {
    const fake = fakeDb([[], [], [], [], [], [], [{ appId: "a1", dbId: "s1" }]]);
    h.current = fake;
    expect((await loadFacts(now)).links).toEqual([{ appId: "a1", dbId: "s1" }]);
    expect(limitOf(fake.queries[fake.queries.length - 1])).toBe(500);
  });
});
