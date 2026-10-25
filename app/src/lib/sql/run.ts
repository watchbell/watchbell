import type { Dsn } from "./dsn";

// Stage 9 slice 2: running one guarded query, and checking a new connection string once, over a tiny driver interface
// (lib/sql/pg-driver.ts is the postgres.js version; tests pass a fake). Every run is one connection: open, BEGIN READ
// ONLY, three SET LOCAL limits, the query (at most ROW_CAP + 1 rows are fetched), ROLLBACK, close. Nothing here logs.

export interface PgConn {
  // A statement of ours (BEGIN, SET LOCAL, ROLLBACK, the probe). Rejects with the driver's error.
  exec(text: string): Promise<void>;
  // A query; the driver stops fetching after `max` rows. Rows are arrays in column order.
  rows(text: string, max: number): Promise<{ columns: string[]; rows: unknown[][] }>;
  close(): Promise<void>;
}
export type Connect = (dsn: Dsn) => Promise<PgConn>;

export const ROW_CAP = 500;
export const PAYLOAD_CAP = 400_000; // characters of JSON rows sent back to the page (the action's body limit is 1 MB)
export const CELL_CAP = 2_000;
export const COLUMN_CAP = 100;
export const HARD_DEADLINE_MS = 15_000; // connect (5 s) + statement (5 s) + slack; then the connection is dropped

export const SESSION_SETUP = [
  "BEGIN READ ONLY",
  "SET LOCAL statement_timeout = '5s'",
  "SET LOCAL lock_timeout = '2s'",
  "SET LOCAL idle_in_transaction_session_timeout = '10s'",
] as const;

export type Cell = string | number | boolean | null;
export type RunOk = { ok: true; columns: string[]; rows: Cell[][]; rowCount: number; truncated: boolean; durationMs: number };
export type RunFail = { ok: false; error: string; durationMs?: number };
export type RunResult = RunOk | RunFail;

const clip = (s: string, max = CELL_CAP) => (s.length > max ? `${s.slice(0, max)}… (${s.length.toLocaleString("en")} chars)` : s);

export function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return clip(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "Invalid date" : v.toISOString();
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v.subarray(0, 64)).toString("hex");
    return `\\x${hex}${v.length > 64 ? `… (${v.length} bytes)` : ""}`;
  }
  try {
    return clip(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)) ?? String(v));
  } catch {
    return clip(String(v));
  }
}

// Caps a fetched result: ROW_CAP rows (the extra one only says "there was more"), COLUMN_CAP columns and PAYLOAD_CAP
// characters in total.
export function shapeRows(columns: string[], raw: unknown[][]): { columns: string[]; rows: Cell[][]; truncated: boolean } {
  const cols = columns.slice(0, COLUMN_CAP).map((c) => clip(String(c), 120));
  let truncated = raw.length > ROW_CAP || columns.length > COLUMN_CAP;
  const rows: Cell[][] = [];
  let size = 0;
  for (const r of raw.slice(0, ROW_CAP)) {
    const row = cols.map((_, i) => toCell(r[i]));
    size += JSON.stringify(row).length;
    if (size > PAYLOAD_CAP) {
      truncated = true;
      break;
    }
    rows.push(row);
  }
  return { columns: cols, rows, truncated };
}

type DriverError = { code?: unknown; severity?: unknown; message?: unknown };

// What the page may see of a failure. A server error (it has a severity) is the owner's own query talking back, so
// its message is shown, cut short; a connection-level error can name the host, so only a fixed sentence is shown.
export function pgErrorText(e: unknown): string {
  const err = (e && typeof e === "object" ? e : {}) as DriverError;
  const code = typeof err.code === "string" ? err.code : "";
  if (code === "28P01" || code === "28000") return "The database refused that user or password.";
  if (code === "3D000") return "That database doesn't exist.";
  if (code === "57014") return "The query took longer than 5 seconds and was cancelled.";
  if (code === "55P03") return "The query waited too long for a lock and was cancelled.";
  if (code === "25006") return "The database refused a write: this console only reads.";
  if (code === "53300") return "The database has no free connections right now. Try again in a minute.";
  if (code === "CONNECT_TIMEOUT" || code === "ETIMEDOUT") return "Couldn't reach the database within 5 seconds.";
  if (code === "DEADLINE") return "The run took too long and the connection was dropped.";
  if (code.startsWith("08") || /^E[A-Z]+$/.test(code) || code.startsWith("CONNECTION_")) return "Couldn't connect to the database.";
  if (typeof err.severity === "string" && typeof err.message === "string") {
    return err.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[connection string]").slice(0, 400);
  }
  return "The query failed.";
}

class Deadline extends Error {
  code = "DEADLINE";
}

async function withDeadline<T>(ms: number, work: Promise<T>, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Deadline("deadline"));
    }, ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

// Opens one connection, runs `body` inside BEGIN READ ONLY + the limits, and always rolls back and closes.
async function session<T>(dsn: Dsn, connect: Connect, body: (c: PgConn) => Promise<T>, deadlineMs: number): Promise<T> {
  let conn: PgConn | null = null;
  const work = (async () => {
    conn = await connect(dsn);
    try {
      for (const s of SESSION_SETUP) await conn.exec(s);
      return await body(conn);
    } finally {
      try {
        await conn.exec("ROLLBACK");
      } catch {
        // the connection may already be gone; closing below ends the transaction anyway
      }
    }
  })();
  work.catch(() => undefined); // after a deadline the late rejection has no listener left
  try {
    return await withDeadline(deadlineMs, work, () => {
      void (conn as PgConn | null)?.close().catch(() => undefined);
    });
  } finally {
    await (conn as PgConn | null)?.close().catch(() => undefined);
  }
}

export type RunDeps = { connect: Connect; clock?: () => number; deadlineMs?: number };

// `text` must already have passed guardSql.
export async function runReadOnly(dsn: Dsn, text: string, deps: RunDeps): Promise<RunResult> {
  const clock = deps.clock ?? (() => performance.now());
  let started = clock();
  try {
    const r = await session(dsn, deps.connect, async (c) => {
      started = clock();
      return c.rows(text, ROW_CAP + 1);
    }, deps.deadlineMs ?? HARD_DEADLINE_MS);
    const durationMs = Math.round(clock() - started);
    const shaped = shapeRows(r.columns, r.rows);
    return { ok: true, ...shaped, rowCount: shaped.rows.length, durationMs };
  } catch (e) {
    return { ok: false, error: pgErrorText(e), durationMs: Math.round(clock() - started) };
  }
}

// ---- the one-time check when the owner saves a connection string ----

export const PRIVILEGE_SQL = `select r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
  exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname not in ('pg_catalog', 'information_schema')
      and n.nspname !~ '^pg_(toast|temp)' and has_schema_privilege(n.oid, 'USAGE')
      and (has_table_privilege(c.oid, 'INSERT') or has_table_privilege(c.oid, 'UPDATE')
        or has_table_privilege(c.oid, 'DELETE') or has_table_privilege(c.oid, 'TRUNCATE'))) as write_table,
  exists (select 1 from pg_catalog.pg_namespace n where n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname !~ '^pg_' and has_schema_privilege(n.oid, 'CREATE')) as create_schema,
  (pg_has_role('pg_write_server_files', 'MEMBER') or pg_has_role('pg_execute_server_program', 'MEMBER')
    or pg_has_role('pg_write_all_data', 'MEMBER') or pg_has_role('pg_read_server_files', 'MEMBER')
    or pg_has_role('pg_signal_backend', 'MEMBER')) as server_roles
from pg_catalog.pg_roles r where r.rolname = current_user`;

export const PROBE_SQL = "CREATE TEMP TABLE watchpost_probe (x int)";
export const CAN_WRITE = "This role can write; use a read-only role.";

const PRIVILEGE_NAMES = ["superuser", "CREATEROLE", "CREATEDB", "REPLICATION", "INSERT/UPDATE/DELETE on a table", "CREATE in a schema", "a pg_write_*, pg_read_server_files, server-program or pg_signal_backend role"];

export type VerifyResult = { ok: true; role: string } | { ok: false; error: string; canWrite?: boolean };

export async function verifyReadOnly(dsn: Dsn, deps: RunDeps): Promise<VerifyResult> {
  try {
    const found = await session(dsn, deps.connect, async (c) => {
      // SET LOCAL already ran (session setup): the limits can be forced. Now the transaction itself must be read-only.
      const ro = await c.rows("SELECT current_setting('transaction_read_only'), current_user", 1);
      const [setting, role] = ro.rows[0] ?? [];
      const priv = await c.rows(PRIVILEGE_SQL, 1);
      const flags = (priv.rows[0] ?? []).map((v) => v === true || v === "t" || v === "true");
      let probeWorked = false;
      try {
        await c.exec(PROBE_SQL);
        probeWorked = true;
      } catch {
        // expected: 25006 read_only_sql_transaction (or a permission error); the transaction is aborted and rolled back
      }
      return { readOnly: setting === "on", role: typeof role === "string" ? role : "", flags, gotPriv: priv.rows.length > 0, probeWorked };
    }, deps.deadlineMs ?? HARD_DEADLINE_MS);
    if (!found.readOnly) return { ok: false, error: "BEGIN READ ONLY didn't make the transaction read-only on this connection. Use the pooler or direct string, not a proxy that rewrites transactions." };
    if (found.probeWorked) return { ok: false, error: `${CAN_WRITE} A table could be created inside a READ ONLY transaction.`, canWrite: true };
    if (!found.gotPriv) return { ok: false, error: "Couldn't read this role's privileges." };
    const has = PRIVILEGE_NAMES.filter((_, i) => found.flags[i]);
    if (has.length) return { ok: false, error: `${CAN_WRITE} It has: ${has.join(", ")}.`, canWrite: true };
    return { ok: true, role: found.role };
  } catch (e) {
    return { ok: false, error: pgErrorText(e) };
  }
}
