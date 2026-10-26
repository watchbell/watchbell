import { beforeEach, describe, expect, it, vi } from "vitest";

// D20 fix round 1: the collector's "node" task. The database and the two reads are stubbed; the order of calls is
// what is checked (I1: nothing at all while switched off; M2: the fetch starts before the database read).
const order: string[] = [];
const state = vi.hoisted(() => ({ row: null as unknown, written: null as unknown }));

vi.mock("@/db/client", () => ({
  db: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => {
      order.push("db read");
      return state.row ? [{ value: state.row }] : [];
    } }) }) }),
    insert: () => ({ values: (v: { value: unknown }) => ({ onConflictDoUpdate: async () => {
      order.push("db write");
      state.written = v.value;
    } }) }),
  }),
}));
vi.mock("@/lib/security/node-runtime", async (orig) => {
  const real = await orig<typeof import("@/lib/security/node-runtime")>();
  return {
    ...real,
    fetchNodeAdvisories: vi.fn(async (opts: { timeoutMs: number }) => {
      order.push(`fetch ${opts.timeoutMs > 1000 ? "with time" : "short"}`);
      return { index: { security: ["24.22.1"], latest: { 24: "24.22.1" } }, indexError: null, cycles: [{ name: "24", isEol: false, eolFrom: "2028-04-30" }], cyclesError: null };
    }),
  };
});

const { taskNode } = await import("./node-runtime");
const NOW = new Date("2026-10-25T03:43:01Z");

beforeEach(() => {
  order.length = 0;
  state.row = null;
  state.written = null;
});

describe("taskNode", () => {
  it("reads both lists first, then the previous row, then writes", async () => {
    const errors: string[] = [];
    await taskNode(NOW, Date.now() + 15_000, errors, {});
    expect(order).toEqual(["fetch with time", "db read", "db write"]);
    expect(errors).toEqual([]);
    expect(state.written).toMatchObject({ indexCheckedAt: NOW.toISOString(), indexError: null, index: { security: ["24.22.1"] } });
  });
  it("does nothing at all while WATCHBELL_NO_UPDATE_CHECK is set (I1)", async () => {
    const errors: string[] = [];
    await taskNode(NOW, Date.now() + 15_000, errors, { WATCHBELL_NO_UPDATE_CHECK: "1" });
    expect(order).toEqual([]);
    expect(errors).toEqual([]);
  });
  it("is deferred with under a second of the run left", async () => {
    await expect(taskNode(NOW, Date.now() + 500, [], {})).rejects.toThrow("skipped, time budget used");
    expect(order).toEqual([]);
  });
});
