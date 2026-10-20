import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "@/db/schema";
import { asVisitor, fakeSeedDemoDb, memberRows, seedUserId, useTestVisitors } from "../../../test/demo-visitors";

// The real generator is ./seed (tested there); the pool is tested with a small deterministic stand-in that also records
// how many seeds run at once.
const seeded = vi.hoisted(() => ({ seeds: [] as string[], running: 0, maxRunning: 0, delayMs: 0 }));
vi.mock("./seed", () => ({
  seedDemoDb: async (...args: Parameters<typeof fakeSeedDemoDb>) => {
    seeded.seeds.push(args[1]);
    seeded.running++;
    seeded.maxRunning = Math.max(seeded.maxRunning, seeded.running);
    try {
      if (seeded.delayMs) await new Promise((r) => setTimeout(r, seeded.delayMs));
      await fakeSeedDemoDb(...args);
    } finally {
      seeded.running--;
    }
  },
}));

import { demoNoticeOf } from "./notices";
import {
  BUSY_WAIT_MS, DEFAULT_POOL_MAX, DEMO_BUSY, DEMO_TOO_MANY, IDLE_MS, MAX_CREATING, RECENT_MS, closeDemoPool, demoDbFor, demoPoolMax,
  setDemoPoolClockOffsetForTests, sweepIdleDemoDbs, withDemoDb,
} from "./pool";
import { CREATIONS_SHARED, demoCreations, resetDemoLimitsForTests, SHARED_CLIENT } from "./visitor-limits";

const rowsOf = (p: PGlite) => memberRows(drizzle({ client: p, schema }));
const owner = (seed: string, email = `${seed}@visitor.test`) => [{ userId: seedUserId(seed), email, role: "owner" }];
const open = (seed: string) => demoDbFor(seed, `${seed}@visitor.test`);
const poolState = () => (globalThis as { __watchpostDemoPool?: { sweeper?: unknown; live: Set<unknown> } }).__watchpostDemoPool!;
// Ages every instance past RECENT_MS (the pool's clock only), so the least recently used one may go for space.
let offset = 0;
const later = () => setDemoPoolClockOffsetForTests((offset += RECENT_MS));
const settledWithin = async (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), ms))]);

// Holds a lease on `seed` (as a request mid-query would) until release() is called.
function hold(seed: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let pglite: PGlite | undefined;
  const done = withDemoDb(seed, async (p) => {
    pglite = p;
    await gate;
  }, `${seed}@visitor.test`);
  const ready = () =>
    vi.waitFor(
      () => {
        if (!pglite) throw new Error("not created yet");
        return pglite;
      },
      { timeout: 30_000 },
    );
  return { release, done, pglite: ready };
}

beforeAll(() => useTestVisitors());
afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDemoPool();
  setDemoPoolClockOffsetForTests((offset = 0));
  resetDemoLimitsForTests();
  Object.assign(seeded, { seeds: [], running: 0, maxRunning: 0, delayMs: 0 });
});

describe("demoPoolMax", () => {
  it("defaults to 3 and follows a positive integer WATCHPOST_DEMO_POOL_MAX", () => {
    expect(DEFAULT_POOL_MAX).toBe(3);
    expect(demoPoolMax({})).toBe(3);
    expect(demoPoolMax({ WATCHPOST_DEMO_POOL_MAX: " 5 " })).toBe(5);
    for (const bad of ["", "0", "-2", "2.5", "lots"]) expect(demoPoolMax({ WATCHPOST_DEMO_POOL_MAX: bad })).toBe(3);
    expect(demoPoolMax({ WATCHBELL_DEMO_POOL_MAX: "7", WATCHPOST_DEMO_POOL_MAX: "5" })).toBe(7);
  });
});

describe("demoDbFor", () => {
  it("creates one migrated, seeded instance per seed, even for concurrent first requests", async () => {
    const [a, b, c] = await Promise.all([open("s-a"), open("s-a"), open("s-b")]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(seeded.seeds.sort()).toEqual(["s-a", "s-b"]);
    expect(await rowsOf(a)).toEqual(owner("s-a"));
    expect(await rowsOf(c)).toEqual(owner("s-b"));
  }, 60_000);

  it("takes the member email from the current demo session when none is passed", async () => {
    const p = await asVisitor("s-session", () => demoDbFor("s-session"));
    expect(await rowsOf(p)).toEqual(owner("s-session"));
  }, 60_000);

  it("gives the same rows for the same seed in a fresh instance", async () => {
    const first = await rowsOf(await open("s-same"));
    await closeDemoPool();
    expect(await rowsOf(await open("s-same"))).toEqual(first);
  }, 60_000);

  it("past the cap closes the least recently used instance, which later comes back identical", async () => {
    const s0 = await open("s-0");
    const before = await rowsOf(s0);
    const s1 = await open("s-1");
    await open("s-2");
    await open("s-0"); // s-0 used again: s-1 is now the least recently used
    later();
    await open("s-3");
    expect(s0.closed).toBe(false);
    expect(s1.closed).toBe(true);
    expect(poolState().live.size).toBe(3);
    const s1Again = await open("s-1"); // re-created (closes s-2)
    expect(s1Again).not.toBe(s1);
    expect(seeded.seeds.filter((s) => s === "s-1")).toHaveLength(2);
    expect(await rowsOf(s1Again)).toEqual(owner("s-1"));

    await open("s-3");
    await open("s-1");
    await open("s-new"); // s-0 is now the least recently used, and the only one not used within RECENT_MS
    expect(s0.closed).toBe(true);
    later();
    const recreated = await open("s-0");
    expect(recreated).not.toBe(s0);
    expect(await rowsOf(recreated)).toEqual(before);
  }, 180_000);

  it("closes instances idle for more than 20 minutes and stops the sweeper once the pool is empty", async () => {
    const idle = await open("s-idle");
    expect(poolState().sweeper).toBeDefined();
    sweepIdleDemoDbs(Date.now() + IDLE_MS - 1000);
    expect(idle.closed).toBe(false);
    sweepIdleDemoDbs(Date.now() + IDLE_MS + 1000);
    await vi.waitFor(() => expect(idle.closed).toBe(true));
    expect(poolState().sweeper).toBeUndefined();
    expect(await open("s-idle")).not.toBe(idle);
  }, 60_000);

  it("never closes an instance in use for space: a new visitor waits until one is free", async () => {
    vi.stubEnv("WATCHPOST_DEMO_POOL_MAX", "2");
    const a = hold("s-a");
    const b = hold("s-b");
    const [pa, pb] = [await a.pglite(), await b.pglite()];
    const c = open("s-c");
    expect(await settledWithin(c, 1500)).toBe(false); // waiting: both live instances are in use
    expect(pa.closed || pb.closed).toBe(false);
    a.release();
    await a.done;
    expect(await settledWithin(c, 1000)).toBe(false); // a was just used: protected for RECENT_MS
    later(); // the waiting request looks again at once
    expect(await rowsOf(await c)).toEqual(owner("s-c"));
    expect(pa.closed).toBe(true);
    expect(pb.closed).toBe(false);
    b.release();
    await b.done;
  }, 60_000);

  it(`fails with "busy" after ${BUSY_WAIT_MS / 1000} s when every instance stays in use`, async () => {
    vi.stubEnv("WATCHPOST_DEMO_POOL_MAX", "1");
    const a = hold("s-a");
    const pa = await a.pglite();
    const started = Date.now();
    // The console's error screen and runGuarded recognise it (lib/demo/notices.ts).
    const busy = await open("s-b").catch((e: unknown) => e);
    expect(busy).toMatchObject({ message: DEMO_BUSY, digest: "watchbell-demo-busy" });
    expect(demoNoticeOf(busy)).toBe(DEMO_BUSY);
    expect(Date.now() - started).toBeGreaterThanOrEqual(BUSY_WAIT_MS - 50);
    expect(pa.closed).toBe(false);
    a.release();
    await a.done;
    later();
    expect(await rowsOf(await open("s-b"))).toEqual(owner("s-b")); // forgotten, so it is retried
    expect(pa.closed).toBe(true);
  }, 60_000);

  it("never closes an instance used within RECENT_MS for space: the new visitor gets busy instead", async () => {
    expect(BUSY_WAIT_MS).toBe(5000);
    expect(RECENT_MS).toBe(60_000);
    vi.stubEnv("WATCHPOST_DEMO_POOL_MAX", "1");
    const a = await open("s-a"); // not in use, but used just now (a page render mid-way between two queries)
    await expect(open("s-b")).rejects.toThrow(DEMO_BUSY);
    expect(a.closed).toBe(false);
    later();
    expect(await rowsOf(await open("s-b"))).toEqual(owner("s-b"));
    expect(a.closed).toBe(true);
  }, 60_000);

  it("limits new instances per client (here the shared bucket: no request), counting a re-created seed once", async () => {
    for (let i = 0; i < CREATIONS_SHARED - 1; i++) expect(demoCreations.take(SHARED_CLIENT, `other-${i}`)).toBe(true);
    await open("s-last"); // the last one this window
    const refused = await open("s-over").catch((e: unknown) => e);
    expect(refused).toMatchObject({ message: DEMO_TOO_MANY, digest: "watchbell-demo-too-many" });
    expect(seeded.seeds).toEqual(["s-last"]); // refused before any work
    expect(poolState().live.size).toBe(1);
    await closeDemoPool();
    expect(await rowsOf(await open("s-last"))).toEqual(owner("s-last")); // re-created for the same seed: not a new one
    resetDemoLimitsForTests();
    expect(await rowsOf(await open("s-over"))).toEqual(owner("s-over"));
  }, 60_000);

  it(`creates at most ${MAX_CREATING} instances at the same time`, async () => {
    vi.stubEnv("WATCHPOST_DEMO_POOL_MAX", "5");
    seeded.delayMs = 400;
    const all = await Promise.all(["s-1", "s-2", "s-3", "s-4", "s-5"].map(open));
    expect(new Set(all).size).toBe(5);
    expect(seeded.maxRunning).toBe(MAX_CREATING);
  }, 120_000);

  it("an instance still in use when evicted stays live (counted) and open until its caller is done", async () => {
    vi.stubEnv("WATCHPOST_DEMO_POOL_MAX", "1");
    const busy = hold("s-busy");
    const p = await busy.pglite();
    await closeDemoPool(); // evicts it, but it is in use
    expect(p.closed).toBe(false);
    const next = open("s-next");
    expect(await settledWithin(next, 1000)).toBe(false); // the evicted instance still holds the only slot
    busy.release();
    await busy.done;
    expect(await rowsOf(await next)).toEqual(owner("s-next"));
    expect(p.closed).toBe(true);
  }, 60_000);

  it("forgets a failed creation so the next request retries", async () => {
    await expect(demoDbFor("s-fail")).rejects.toThrow("Not signed in to the demo"); // no email, no session
    expect(poolState().live.size).toBe(0);
    expect(await rowsOf(await demoDbFor("s-fail", "fail@visitor.test"))).toEqual(owner("s-fail", "fail@visitor.test"));
  }, 60_000);
});
