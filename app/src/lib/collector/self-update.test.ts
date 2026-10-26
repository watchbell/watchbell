import { beforeEach, describe, expect, it, vi } from "vitest";

// 1.2.3: the self-hosted update check that runs with the "node" task, and the banner read.
const log: string[] = [];
const state = vi.hoisted(() => ({ rows: [] as { key: string; value: unknown }[] }));

vi.mock("@/db/client", () => ({
  db: () => ({
    insert: () => ({ values: (v: { key: string; value: unknown }) => ({
      onConflictDoUpdate: async () => { log.push(`upsert ${v.key} ${JSON.stringify(v.value)}`); },
      onConflictDoNothing: async () => { log.push(`insert-if-new ${v.key} ${JSON.stringify(v.value)}`); },
    }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => state.rows }) }) }),
  }),
}));

const { markVersionSeen, readUpdateNotice, taskSelfUpdate } = await import("./self-update");
const NOW = new Date("2026-10-26T03:43:01Z");
const SELF = { WATCHBELL_MODE: "selfhost", WATCHBELL_VERSION: "1.2.3" };
const npm = (version: string) => (async () => new Response(JSON.stringify({ version }), { status: 200 })) as unknown as typeof fetch;

beforeEach(() => {
  log.length = 0;
  state.rows = [];
});

describe("taskSelfUpdate", () => {
  it("self-hosted: stores npm's latest and records the running version as seen once", async () => {
    const errors: string[] = [];
    await taskSelfUpdate(NOW, Date.now() + 15_000, errors, SELF, npm("1.2.4"));
    expect(log).toEqual([
      `upsert watchbell.latest {"version":"1.2.4","checkedAt":"${NOW.toISOString()}"}`,
      'insert-if-new watchbell.seenVersion {"version":"1.2.3"}',
    ]);
    expect(errors).toEqual([]);
  });

  it("does nothing in the cloud edition, without a version, or with WATCHBELL_NO_UPDATE_CHECK", async () => {
    const asked = vi.fn(npm("9.9.9"));
    await taskSelfUpdate(NOW, Date.now() + 15_000, [], { WATCHBELL_VERSION: "1.2.3" }, asked);
    await taskSelfUpdate(NOW, Date.now() + 15_000, [], { WATCHBELL_MODE: "selfhost" }, asked);
    await taskSelfUpdate(NOW, Date.now() + 15_000, [], { ...SELF, WATCHBELL_NO_UPDATE_CHECK: "1" }, asked);
    expect(asked).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it("an unreachable registry is one error line and keeps the last answer", async () => {
    const errors: string[] = [];
    await taskSelfUpdate(NOW, Date.now() + 15_000, errors, SELF, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    expect(errors).toEqual(["update check: Couldn't reach registry.npmjs.org"]);
    expect(log).toEqual(['insert-if-new watchbell.seenVersion {"version":"1.2.3"}']);
  });
});

describe("readUpdateNotice / markVersionSeen", () => {
  it("says a newer version is out, or What's new after an update", async () => {
    state.rows = [{ key: "watchbell.latest", value: { version: "1.2.4", checkedAt: "x" } }, { key: "watchbell.seenVersion", value: { version: "1.2.2" } }];
    expect(await readUpdateNotice(SELF)).toEqual({ kind: "update", running: "1.2.3", latest: "1.2.4" });
    state.rows = [{ key: "watchbell.latest", value: { version: "1.2.3", checkedAt: "x" } }, { key: "watchbell.seenVersion", value: { version: "1.2.2" } }];
    expect(await readUpdateNotice(SELF)).toEqual({ kind: "updated", version: "1.2.3" });
    expect(await readUpdateNotice({ WATCHBELL_VERSION: "1.2.3" })).toBeNull(); // cloud
  });

  it("Got it records the running version as seen", async () => {
    await markVersionSeen(SELF);
    expect(log).toEqual(['upsert watchbell.seenVersion {"version":"1.2.3"}']);
  });
});
