import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db/client", () => ({ db: vi.fn() }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: vi.fn() }));

import { IDLE_MIN_S, POOL_CAP, POOL_SLOTS, trimCount } from "./pool-guard";

describe("pool guard", () => {
  it("keeps the app at 10 of the 15 pooler slots", () => {
    expect(POOL_CAP).toBe(10);
    expect(POOL_SLOTS).toBe(15);
    expect(POOL_CAP).toBeLessThan(POOL_SLOTS);
    expect(IDLE_MIN_S).toBeGreaterThanOrEqual(10);
  });

  it("closes only what is over the cap", () => {
    expect(trimCount(4)).toBe(0);
    expect(trimCount(10)).toBe(0);
    expect(trimCount(11)).toBe(1);
    expect(trimCount(15)).toBe(5);
  });
});

describe("pool card", () => {
  it("shows the share of the 15 slots and warns from the cap", async () => {
    const { poolView } = await import("./pool-guard");
    expect(poolView({ used: 3, active: 1 })).toEqual({ pct: 20, warn: false });
    expect(poolView({ used: 10, active: 2 })).toEqual({ pct: 67, warn: true });
    expect(poolView({ used: 20, active: 0 }).pct).toBe(100);
  });
});

describe("queryTable", () => {
  it("names the ops table of the last query, never the query itself", async () => {
    const { queryTable } = await import("./pool-guard");
    expect(queryTable('select "id" from "ops"."monitors" where "id" = $1')).toBe("monitors");
    expect(queryTable('insert into "ops"."runner_jobs" ("kind") values ($1)')).toBe("runner_jobs");
    expect(queryTable('update ops.settings set value = $1')).toBe("settings");
    expect(queryTable("select 1")).toBeNull();
    expect(queryTable(null)).toBeNull();
  });
});

describe("pickVictims", () => {
  // a different table per connection, so the doubles rule stays out of these cases
  const c = (pid: number, state: string, idleS: number, runS = 0, table: string | null = `t${pid}`) => ({ pid, state, idleS, runS, table });
  it("does nothing under the cap", async () => {
    const { pickVictims } = await import("./pool-guard");
    expect(pickVictims([c(1, "idle", 500), c(2, "idle", 400)])).toEqual([]);
  });
  it("closes the longest-idle ones first, just enough to get back to 10", async () => {
    const { pickVictims } = await import("./pool-guard");
    const conns = Array.from({ length: 11 }, (_, i) => c(i + 1, "idle", (i + 1) * 30));
    expect(pickVictims(conns).map((v) => v.pid)).toEqual([11, 10]);
  });
  it("when all are busy, picks the slowest queries over 60 s and never a short one", async () => {
    const { pickVictims } = await import("./pool-guard");
    const conns = [...Array.from({ length: 9 }, (_, i) => c(i + 1, "active", 0, 5)), c(20, "active", 0, 300, "logs"), c(21, "active", 0, 90, "runner_jobs")];
    expect(pickVictims(conns).map((v) => v.pid)).toEqual([20, 21]);
    expect(pickVictims(Array.from({ length: 12 }, (_, i) => c(i + 1, "active", 0, 10)))).toEqual([]);
  });
  it("names the culprits by table", async () => {
    const { culpritText } = await import("./pool-guard");
    expect(culpritText([c(1, "idle", 1, 0, "monitors"), c(2, "idle", 1, 0, "monitors"), c(3, "idle", 1, 0, null)])).toEqual(["monitors ×2", "unknown ×1"]);
  });
});

describe("doubles", () => {
  const c = (pid: number, state: string, idleS: number, table: string | null) => ({ pid, state, idleS, runS: 0, table });
  it("keeps the freshest idle connection per table and closes older repeats idle ≥ 60 s, even under the cap", async () => {
    const { pickVictims } = await import("./pool-guard");
    const conns = [c(1, "idle", 62, "create_requests"), c(2, "idle", 62, "create_requests"), c(3, "idle", 60, "ai_questions"), c(4, "idle", 70, "ai_questions"), c(5, "idle", 106, "members"), c(6, "idle", 30, "members"), c(7, "active", 0, "monitors")];
    expect(pickVictims(conns).map((v) => v.pid).sort()).toEqual([2, 4, 5]);
  });
  it("leaves a repeat that has been idle under 60 s, busy ones and unknown tables", async () => {
    const { pickVictims } = await import("./pool-guard");
    expect(pickVictims([c(1, "idle", 10, "members"), c(2, "idle", 40, "members"), c(3, "active", 0, "members"), c(4, "idle", 200, null), c(5, "idle", 300, null)])).toEqual([]);
  });
});
