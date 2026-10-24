import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { snapshots } from "@/db/schema";
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
});
