// Test helper: a chainable stand-in for drizzle's query builder. Every method returns the same builder; awaiting it
// resolves with the next queued result and records the calls made (so tests can check LIMITs).
export type Call = { method: string; args: unknown[] };

// `writeResults` feeds insert/update/delete (what `.returning()` resolves to); a write with none queued resolves to [].
// A queued function is called with the statement's recorded calls when it is awaited, so a test can answer from state
// it keeps itself (for example a monitor row that a compare-and-set update only changes when its WHERE still matches).
export type Answer = unknown[] | Error | ((calls: Call[]) => unknown[]);

export function fakeDb(results: Answer[], writeResults: Answer[] = []) {
  const queue = [...results];
  const writeQueue = [...writeResults];
  const queries: Call[][] = [];
  const writes: { kind: "insert" | "update" | "delete"; table: unknown; calls: Call[] }[] = [];
  const start = (source: Answer[] = queue, kind?: "insert" | "update" | "delete", table?: unknown, first?: Call) => {
    const calls: Call[] = first ? [first] : [];
    if (kind) writes.push({ kind, table, calls });
    else queries.push(calls);
    const builder: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            const next = source.shift() ?? [];
            const rows = typeof next === "function" ? next(calls) : next;
            return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => (rows instanceof Error ? reject?.(rows) : resolve(rows));
          }
          return (...args: unknown[]) => {
            calls.push({ method: String(prop), args });
            return builder;
          };
        },
      },
    );
    return builder;
  };
  // The select's own arguments (the selected fields) are recorded as a "select" call, so tests can render them.
  const read = (method: string) => (...args: unknown[]) => start(queue, undefined, undefined, { method, args });
  let executes = 0;
  // The table the write targets (insert(t) / update(t) / delete(t)) is recorded so tests can pin which tables change.
  const write = (kind: "insert" | "update" | "delete") => (table?: unknown) => start(writeQueue, kind, table);
  const conn = {
    select: read("select"), selectDistinct: read("selectDistinct"), selectDistinctOn: read("selectDistinctOn"), insert: write("insert"), update: write("update"), delete: write("delete"),
    // db().execute(sql`...`) (the advisory lock) is only counted; a transaction runs on the same fake.
    execute: async () => { executes++; return []; },
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(conn),
  };
  return { db: () => conn, queries, writes, executes: () => executes, remaining: () => queue.length };
}

export const limitOf = (q: Call[]) => q.find((c) => c.method === "limit")?.args[0];

// The first argument of the recorded `.where(...)` (a drizzle SQL expression), if any.
export const whereOf = (calls: Call[]) => calls.find((c) => c.method === "where")?.args[0] as { getSQL: () => unknown } | undefined;

// The object passed to `.set(...)` / `.values(...)` of a recorded write.
export const payloadOf = (calls: Call[]) => calls.find((c) => c.method === "set" || c.method === "values")?.args[0] as Record<string, unknown> | undefined;
