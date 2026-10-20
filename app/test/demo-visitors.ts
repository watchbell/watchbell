import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { asc } from "drizzle-orm";
import type { Db } from "@/db/client";
import { members } from "@/db/schema";
import { setDemoVisitorResolverForTests, type DemoVisitor } from "@/lib/demo/session";

// Test helpers for the demo pool and facade (not imported by the app). An AsyncLocalStorage stands in for "the current
// request", so concurrent visitors in one test behave like concurrent requests in Next.
const requests = new AsyncLocalStorage<DemoVisitor>();

export function useTestVisitors(): void {
  setDemoVisitorResolverForTests(async () => {
    const visitor = requests.getStore();
    if (!visitor) throw new Error("Not signed in to the demo");
    return visitor;
  });
}

export const asVisitor = <T>(seed: string, fn: () => Promise<T>): Promise<T> => requests.run({ seed, email: `${seed}@visitor.test` }, fn);

// Deterministic for a seed, like the real generator: the visitor's member row with a seed-derived user id.
export function seedUserId(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function fakeSeedDemoDb(db: Db, seed: string, _now: Date, email: string): Promise<void> {
  await db.insert(members).values({ userId: seedUserId(seed), email, role: "owner" });
}

// Awaited here so the query runs inside the caller's visitor context (a Drizzle builder only runs when awaited).
export const memberRows = async (db: Db) =>
  await db.select({ userId: members.userId, email: members.email, role: members.role }).from(members).orderBy(asc(members.email));
