import type { PGlite, QueryOptions, Results, Transaction } from "@electric-sql/pglite";

// The client the demo's Drizzle instance (db() in demo) is built on. drizzle-orm/pglite only calls client.query() and
// client.transaction(); exec() is here for completeness. Every call resolves the CURRENT request's visitor afresh, so one
// module-level Drizzle instance serves every visitor and nothing per-visitor is ever cached here. A transaction runs
// entirely on the instance it started on: drizzle hands its queries to the `tx` PGlite passes in, not back to this facade.
// Session and pool are loaded on first use (once), so importing this module loads no PGlite.
let modules: Promise<[typeof import("./session"), typeof import("./pool")]> | undefined;
const load = () => (modules ??= Promise.all([import("./session"), import("./pool")]));

async function onVisitorDb<T>(fn: (pglite: PGlite) => Promise<T>): Promise<T> {
  const [{ currentDemoVisitor }, { withDemoDb }] = await load();
  const visitor = await currentDemoVisitor();
  return withDemoDb(visitor.seed, fn, visitor.email);
}

// Opens (creating it if needed) the signed-in visitor's database outside Drizzle; nothing when signed out. The console
// layout calls it first in demo: an error from the pool (busy, too many new sessions; ./notices) then reaches the error
// screen as itself, where a query's would arrive wrapped by Drizzle without its digest.
export async function openDemoDb(): Promise<void> {
  const [{ readDemoVisitor }, { withDemoDb }] = await load();
  const visitor = await readDemoVisitor();
  if (visitor) await withDemoDb(visitor.seed, async () => undefined, visitor.email);
}

export const demoClient = {
  query<T>(query: string, params?: unknown[], options?: QueryOptions): Promise<Results<T>> {
    return onVisitorDb((p) => p.query<T>(query, params, options));
  },
  exec(query: string, options?: QueryOptions): Promise<Array<Results>> {
    return onVisitorDb((p) => p.exec(query, options));
  },
  transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    return onVisitorDb((p) => p.transaction(callback));
  },
};

// drizzle-orm/pglite types its client as PGlite; only the methods above are ever used.
export const demoPglite = demoClient as unknown as PGlite;
