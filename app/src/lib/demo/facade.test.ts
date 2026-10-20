import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { members } from "@/db/schema";
import { asVisitor, fakeSeedDemoDb, memberRows, seedUserId, useTestVisitors } from "../../../test/demo-visitors";

// Review Focus 1: one module-level db() in demo serves every visitor; each query must land on the CURRENT request's
// instance, and a transaction must stay on the instance it began on, while other visitors' queries interleave with it.
vi.mock("./seed", () => ({ seedDemoDb: fakeSeedDemoDb }));

import { openDemoDb } from "./facade";
import { DEMO_BUSY } from "./notices";
import { closeDemoPool } from "./pool";

let db: typeof import("@/db/client").db;

beforeAll(async () => {
  vi.stubEnv("WATCHBELL_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@must-not-be-used.example.com:5432/postgres");
  useTestVisitors();
  const client = await import("@/db/client");
  await client.ready();
  db = client.db;
});
afterEach(() => closeDemoPool());
afterAll(() => vi.unstubAllEnvs());

const addMember = (email: string) => db().insert(members).values({ userId: crypto.randomUUID(), email, role: "viewer" });
const emails = async () => (await memberRows(db())).map((r) => r.email);
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("demo db() through the facade", () => {
  it("is one Drizzle instance whose queries go to the current visitor's database", async () => {
    expect(db()).toBe(db());
    const a = await asVisitor("v-a", () => memberRows(db()));
    const b = await asVisitor("v-b", () => memberRows(db()));
    expect(a).toEqual([{ userId: seedUserId("v-a"), email: "v-a@visitor.test", role: "owner" }]);
    expect(b).toEqual([{ userId: seedUserId("v-b"), email: "v-b@visitor.test", role: "owner" }]);
  }, 60_000);

  it("keeps two visitors apart when their queries interleave", async () => {
    const visit = (seed: string) =>
      asVisitor(seed, async () => {
        for (let i = 0; i < 15; i++) {
          await addMember(`${seed}-${i}@visitor.test`);
          await tick();
        }
        return emails();
      });
    const [a, b] = await Promise.all([visit("v-a"), visit("v-b")]);
    expect(a).toHaveLength(16);
    expect(b).toHaveLength(16);
    expect(a.every((e) => e.startsWith("v-a"))).toBe(true);
    expect(b.every((e) => e.startsWith("v-b"))).toBe(true);
  }, 60_000);

  it("runs a transaction on the instance it began on, committing or rolling back only there", async () => {
    let releaseA!: () => void;
    const aWaits = new Promise<void>((r) => (releaseA = r));
    let aStarted!: () => void;
    const aInside = new Promise<void>((r) => (aStarted = r));

    // Visitor A: a transaction that writes, pauses (while B works on its own database), writes again, then fails.
    const a = asVisitor("v-a", () =>
      db().transaction(async (tx) => {
        await tx.insert(members).values({ userId: crypto.randomUUID(), email: "a-tx-1@visitor.test", role: "viewer" });
        aStarted();
        await aWaits;
        await tx.insert(members).values({ userId: crypto.randomUUID(), email: "a-tx-2@visitor.test", role: "viewer" });
        const inside = await tx.select({ email: members.email }).from(members).where(sql`${members.email} like 'a-tx-%'`);
        expect(inside).toHaveLength(2);
        throw new Error("roll back A");
      }),
    );
    await aInside;
    // Visitor B meanwhile: a committed transaction and plain queries on B's instance, not blocked by A's open transaction.
    await asVisitor("v-b", async () => {
      await db().transaction(async (tx) => {
        await tx.insert(members).values({ userId: crypto.randomUUID(), email: "b-tx@visitor.test", role: "viewer" });
      });
      expect(await emails()).toEqual(["b-tx@visitor.test", "v-b@visitor.test"]);
    });
    releaseA();
    await expect(a).rejects.toThrow("roll back A");

    expect(await asVisitor("v-a", emails)).toEqual(["v-a@visitor.test"]);
    expect(await asVisitor("v-b", emails)).toEqual(["b-tx@visitor.test", "v-b@visitor.test"]);

    // And a committed transaction for A lands on A only.
    await asVisitor("v-a", () => db().transaction((tx) => tx.update(members).set({ role: "operator" }).where(eq(members.email, "v-a@visitor.test"))));
    expect((await asVisitor("v-a", () => memberRows(db())))[0].role).toBe("operator");
    expect((await asVisitor("v-b", () => memberRows(db()))).find((r) => r.email === "v-b@visitor.test")?.role).toBe("owner");
  }, 60_000);

  it("openDemoDb opens the visitor's database outside Drizzle, so the pool's busy error arrives as itself", async () => {
    await asVisitor("v-open", () => openDemoDb());
    expect(await asVisitor("v-open", emails)).toEqual(["v-open@visitor.test"]);
    vi.stubEnv("WATCHBELL_DEMO_POOL_MAX", "1");
    try {
      // v-open was used just now, so the only slot can't be freed: busy, with the digest the error screen reads.
      await expect(asVisitor("v-other", () => openDemoDb())).rejects.toMatchObject({ message: DEMO_BUSY, digest: "watchbell-demo-busy" });
    } finally {
      vi.stubEnv("WATCHBELL_DEMO_POOL_MAX", "");
    }
  }, 60_000);

  it("refuses outside a demo session instead of falling back to anything", async () => {
    const err = await memberRows(db()).catch((e: unknown) => e);
    expect((err as Error).cause).toEqual(new Error("Not signed in to the demo"));
  });
});
