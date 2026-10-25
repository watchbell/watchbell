import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resources, snapshots } from "@/db/schema";
import { fakeDb } from "@/lib/data/fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/data/sections-db", async (orig) => ({ ...(await orig<typeof import("@/lib/data/sections-db")>()), pausedSections: async () => new Set() }));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), updateTag: vi.fn() }));
vi.mock("./db-tasks", async (orig) => ({ ...(await orig<typeof import("./db-tasks")>()), appsWithPausedDatabase: async () => new Set<string>() }));

import { refreshAppSnapshots } from "./run";

const NOW = new Date("2026-10-13T12:40:00Z");
const dialect = new PgDialect();

beforeEach(() => { h.current = null; });

describe("refreshAppSnapshots", () => {
  // resources, monitors, building deployments, previous snapshots
  const app = { id: "a1", name: "web" };
  const mon = { resourceId: "a1", state: "ok", lastStatus: 200, lastLatencyMs: 120 };

  it("merges the minute's facts into the snapshot's data (jsonb ||) so keys written by slower tasks, such as pageviews, survive", async () => {
    const f = fakeDb([[app], [mon], [], [{ resourceId: "a1", state: "ok" }]]);
    h.current = f;
    await refreshAppSnapshots(NOW);
    const w = f.writes.find((x) => x.table === snapshots && x.kind === "insert")!;
    const conflict = w.calls.find((c) => c.method === "onConflictDoUpdate")!.args[0] as { set: { data: never; state: string } };
    const q = dialect.sqlToQuery(conflict.set.data);
    expect(q.sql).toMatch(/"data" \|\| \$1::jsonb/);
    expect(JSON.parse(q.params[0] as string)).toEqual({ code: null, latencyMs: 120, dbPaused: false });
    // its own keys only: nothing in the patch can drop `pageviews`
    expect(Object.keys(JSON.parse(q.params[0] as string))).not.toContain("pageviews");
    expect(conflict.set.state).toBe("ok");
  });

  // Watchbell 1.2.1: a monitor still on a domain the app no longer has makes the app degraded ("Domain changed"), not down.
  it("counts a failing monitor on a moved domain as a warning for the app, and a failing attached one as down", async () => {
    const meta = { domains: ["new.example.com"], primaryDomain: "new.example.com" };
    const run = async (url: string, lastError = "HTTP 404 · DEPLOYMENT_NOT_FOUND") => {
      const f = fakeDb([[{ ...app, meta }], [{ ...mon, id: "m1", kind: "http", url, state: "err", lastStatus: 404, lastError }], [], []]);
      h.current = f;
      await refreshAppSnapshots(NOW);
      const w = f.writes.find((x) => x.table === snapshots && x.kind === "insert")!;
      return (w.calls.find((c) => c.method === "onConflictDoUpdate")!.args[0] as { set: { state: string } }).set.state;
    };
    expect(await run("https://old.example.com/")).toBe("warn");
    expect(await run("https://new.example.com/")).toBe("err");
    expect(await run("https://api.mybackend.com/", "HTTP 502")).toBe("err"); // a non-Vercel host is never "moved"
  });

  // Review T3 I2: Vercel's DEPLOYMENT_NOT_FOUND is remembered on the app, so the move survives a timeout in between.
  it("records a host Vercel says it doesn't serve in the app's pastDomains, once", async () => {
    const meta = { domains: ["new.example.com"], primaryDomain: "new.example.com" };
    const f = fakeDb([[{ ...app, meta }], [{ ...mon, id: "m1", kind: "http", url: "https://old.example.com/", state: "err", lastStatus: 404, lastError: "HTTP 404 · DEPLOYMENT_NOT_FOUND" }], [], []]);
    h.current = f;
    await refreshAppSnapshots(NOW);
    const w = f.writes.filter((x) => x.table === resources && x.kind === "update");
    expect(w).toHaveLength(1);
    const set = w[0].calls.find((c) => c.method === "set")!.args[0] as { meta: never };
    expect(dialect.sqlToQuery(set.meta).params).toContain(JSON.stringify({ pastDomains: ["old.example.com"] }));
    const again = fakeDb([[{ ...app, meta: { ...meta, pastDomains: ["old.example.com"] } }], [{ ...mon, id: "m1", kind: "http", url: "https://old.example.com/", state: "err", lastStatus: null, lastError: "Timed out" }], [], []]);
    h.current = again;
    await refreshAppSnapshots(NOW);
    expect(again.writes.filter((x) => x.table === resources)).toEqual([]);
  });
});
