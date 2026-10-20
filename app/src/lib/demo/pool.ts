import "server-only";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { readEnv } from "@/lib/brand-env";
import { DEMO_BUSY, DEMO_TOO_MANY, demoNoticeError } from "./notices";
import { seedDemoDb } from "./seed";
import { currentDemoClientKey, currentDemoEmail } from "./session";
import { demoCreations } from "./visitor-limits";

// Demo mode: one in-memory PGlite per visitor seed, migrated from drizzle-selfhost/ and seeded on first use. An evicted
// visitor's next request re-creates the same data from the same seed (their own writes are lost, which the banner says).
//
// Memory cap: at most demoPoolMax() LIVE instances per server process (about 200-250 MB each, measured; a Vercel
// function has 2 GB). Live = being created, in the pool, or evicted but still in use or still closing. A new visitor
// needs a free slot: the least recently used instance that nobody is using and nobody has used for RECENT_MS is closed to
// make one. An instance used within RECENT_MS is never closed for space, so a visitor who is clicking around (a page
// render is many queries) doesn't lose their database between two of them; when no instance can go, the request waits
// up to BUSY_WAIT_MS for one and then fails with DEMO_BUSY (an error the console shows as itself, ./notices). Instances
// idle longer than IDLE_MS are closed. At most MAX_CREATING instances are created (migrated + seeded) at the same time,
// and each client may create only a few per window (./visitor-limits; over it, DEMO_TOO_MANY).
export const DEFAULT_POOL_MAX = 3;
export const IDLE_MS = 20 * 60 * 1000;
export const RECENT_MS = 60 * 1000;
export const BUSY_WAIT_MS = 5 * 1000;
export const MAX_CREATING = 2;
export { DEMO_BUSY, DEMO_TOO_MANY };
const SWEEP_EVERY_MS = 60 * 1000;

// The pool's clock. Tests move it forward (setDemoPoolClockOffsetForTests) to age instances without waiting a minute;
// requests waiting for a slot look again at once.
let clockOffset = 0;
const clock = (): number => Date.now() + clockOffset;

export function setDemoPoolClockOffsetForTests(ms: number): void {
  if (!process.env.VITEST) throw new Error("setDemoPoolClockOffsetForTests is for tests only");
  clockOffset = ms;
  wake();
}

// WATCHBELL_DEMO_POOL_MAX (or the old WATCHPOST_ name; a positive integer), else DEFAULT_POOL_MAX.
export function demoPoolMax(source: Record<string, string | undefined> = process.env): number {
  const n = Number((readEnv(source, "DEMO_POOL_MAX") ?? "").trim());
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_POOL_MAX;
}

type Entry = {
  seed: string;
  pglite: Promise<PGlite>; // shared by every caller while it is being created (in-flight dedupe)
  created: boolean;
  lastUsed: number; // when a request last started or finished using it
  leases: number; // callers inside withDemoDb; an entry with leases is never evicted for space or idleness
  evicted: boolean;
  closing?: Promise<void>;
};

type Pool = {
  entries: Map<string, Entry>; // order is recency: a use moves the entry to the end, so the first is least recently used
  live: Set<Entry>; // what counts against the cap
  waiters: Set<() => void>; // requests waiting for a slot, woken whenever one might have opened
  creating: number;
  creationQueue: Array<() => void>;
  sweeper?: ReturnType<typeof setInterval>;
};
// On globalThis so a dev-server reload doesn't orphan open instances.
const pool: Pool = ((globalThis as { __watchpostDemoPool?: Pool }).__watchpostDemoPool ??= {
  entries: new Map(),
  live: new Set(),
  waiters: new Set(),
  creating: 0,
  creationQueue: [],
});

function wake(): void {
  const waiters = [...pool.waiters];
  pool.waiters.clear();
  for (const w of waiters) w();
}

function waitForChange(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      pool.waiters.delete(done);
      resolve();
    }
    pool.waiters.add(done);
  });
}

function closeIfDone(entry: Entry): void {
  if (!entry.evicted || entry.leases > 0 || entry.closing) return;
  entry.closing = entry.pglite
    .then((p) => p.close())
    .catch(() => undefined) // a failed creation has nothing to close
    .finally(() => {
      pool.live.delete(entry);
      wake();
    });
}

function evict(entry: Entry): void {
  if (pool.entries.get(entry.seed) === entry) pool.entries.delete(entry.seed);
  entry.evicted = true;
  if (pool.entries.size === 0 && pool.sweeper) {
    clearInterval(pool.sweeper);
    pool.sweeper = undefined;
  }
  closeIfDone(entry);
  wake(); // a request waiting for a slot for this very entry gives up now
}

const unused = (e: Entry): boolean => e.created && e.leases === 0 && !e.evicted;
// May be closed to make room: unused, and not used within RECENT_MS.
const evictableForSpace = (e: Entry, now: number): boolean => unused(e) && now - e.lastUsed >= RECENT_MS;

// Closes every instance nobody is using that has been idle for longer than IDLE_MS at `now`. Runs every minute while
// the pool holds anything.
export function sweepIdleDemoDbs(now: number = clock()): void {
  for (const entry of [...pool.entries.values()]) {
    if (unused(entry) && now - entry.lastUsed > IDLE_MS) evict(entry);
  }
}

// How long until the next unused instance turns RECENT_MS old (and so may go for space); Infinity when none will.
function untilNextEvictable(now: number): number {
  let soonest = Infinity;
  for (const e of pool.entries.values()) if (unused(e)) soonest = Math.min(soonest, e.lastUsed + RECENT_MS - now);
  return Math.max(0, soonest);
}

// Claims a live slot for `entry`. When the pool is full, the least recently used instance that may go
// (evictableForSpace) is closed; when none may, it waits for one until BUSY_WAIT_MS has passed.
async function claimSlot(entry: Entry): Promise<void> {
  const deadline = clock() + BUSY_WAIT_MS;
  for (;;) {
    if (entry.evicted) throw new Error("The demo database was closed. Reload the page.");
    if (pool.live.size < demoPoolMax()) {
      pool.live.add(entry); // synchronously after the check, so two claims can't take the same slot
      return;
    }
    const now = clock();
    const victim = [...pool.entries.values()].find((e) => evictableForSpace(e, now));
    if (victim) {
      evict(victim);
      await victim.closing;
      continue;
    }
    const left = deadline - now;
    if (left <= 0) throw demoNoticeError(DEMO_BUSY);
    await waitForChange(Math.min(left, untilNextEvictable(now) + 1));
  }
}

async function takeCreationTurn(): Promise<void> {
  if (pool.creating < MAX_CREATING) {
    pool.creating++;
    return;
  }
  await new Promise<void>((resolve) => pool.creationQueue.push(resolve));
}

function endCreationTurn(): void {
  const next = pool.creationQueue.shift();
  if (next) next(); // the turn passes straight to the next creation; the count stays the same
  else pool.creating--;
}

async function create(entry: Entry, email: string | undefined): Promise<PGlite> {
  // Counted per client before anything is spent; re-creating the same seed within the window doesn't count again.
  if (!demoCreations.take(await currentDemoClientKey(), entry.seed)) throw demoNoticeError(DEMO_TOO_MANY);
  await claimSlot(entry);
  try {
    const visitorEmail = email ?? (await currentDemoEmail());
    await takeCreationTurn();
    try {
      const pglite = await PGlite.create();
      try {
        const db = drizzle({ client: pglite, schema });
        await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
        await seedDemoDb(db, entry.seed, new Date(), visitorEmail);
      } catch (e) {
        await pglite.close().catch(() => undefined);
        throw e;
      }
      entry.created = true;
      return pglite;
    } finally {
      endCreationTurn();
    }
  } catch (e) {
    pool.live.delete(entry);
    throw e;
  } finally {
    wake(); // a created instance may now be evictable; a failed one freed its slot
  }
}

function acquire(seed: string, email: string | undefined): Entry {
  if (!seed) throw new Error("Demo seed missing");
  sweepIdleDemoDbs();
  let entry = pool.entries.get(seed);
  if (entry) {
    pool.entries.delete(seed); // re-inserted below as the most recently used
  } else {
    const created = { seed, created: false, lastUsed: 0, leases: 0, evicted: false } as Entry;
    created.pglite = create(created, email);
    // A failed creation (busy, over the limit, no session) is forgotten so the next request retries instead of getting
    // the same error.
    created.pglite.catch(() => {
      if (pool.entries.get(seed) === created) pool.entries.delete(seed);
    });
    entry = created;
  }
  entry.lastUsed = clock();
  pool.entries.set(seed, entry);
  if (!pool.sweeper) {
    pool.sweeper = setInterval(() => sweepIdleDemoDbs(), SWEEP_EVERY_MS);
    pool.sweeper.unref?.();
  }
  return entry;
}

// The visitor's PGlite for `seed`, created (migrated + seeded) on first use. `email` is the member the seed creates;
// when omitted it comes from the current demo session, and it is only read when the instance has to be created.
// Holds no lease: the instance can be closed for space once the caller stops using it through withDemoDb.
export function demoDbFor(seed: string, email?: string): Promise<PGlite> {
  return acquire(seed, email).pglite;
}

// Runs fn on the visitor's PGlite; while fn runs the instance is never closed for space or idleness.
export async function withDemoDb<T>(seed: string, fn: (pglite: PGlite) => Promise<T>, email?: string): Promise<T> {
  const entry = acquire(seed, email);
  entry.leases++; // same tick as acquire, so the entry can't be evicted in between
  try {
    return await fn(await entry.pglite);
  } finally {
    entry.leases--;
    entry.lastUsed = clock();
    closeIfDone(entry);
    wake(); // it may now be evictable for a request waiting for a slot
  }
}

// Evicts every instance and waits until every one not in use has closed (also those evicted earlier). An instance still
// in use closes when its caller finishes.
export async function closeDemoPool(): Promise<void> {
  for (const entry of [...pool.entries.values()]) evict(entry);
  await Promise.all([...pool.live].map((e) => e.closing));
}
