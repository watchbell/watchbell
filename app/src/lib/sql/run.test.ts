import { describe, expect, it, vi } from "vitest";
import type { Dsn } from "./dsn";
import {
  CAN_WRITE, CELL_CAP, COLUMN_CAP, PAYLOAD_CAP, PRIVILEGE_SQL, PROBE_SQL, pgErrorText, ROW_CAP, runReadOnly, SESSION_SETUP, shapeRows, toCell,
  verifyReadOnly, type PgConn,
} from "./run";

const DSN: Dsn = { host: "ep-quiet-dawn-123456-pooler.us-east-2.aws.neon.tech", port: 5432, user: "watchpost_ro", password: "fake-test-password", database: "neondb" };

type Script = {
  rows?: (text: string, max: number) => Promise<{ columns: string[]; rows: unknown[][] }>;
  exec?: (text: string) => Promise<void>;
  connectError?: unknown;
};

// A fake driver that records every statement in order.
function fake(s: Script = {}) {
  const log: string[] = [];
  const close = vi.fn(async () => undefined);
  const connect = vi.fn(async (): Promise<PgConn> => {
    if (s.connectError) throw s.connectError;
    return {
      exec: async (t) => { log.push(t); await s.exec?.(t); },
      rows: async (t, max) => { log.push(`ROWS(${max}): ${t}`); return s.rows ? s.rows(t, max) : { columns: ["x"], rows: [[1]] }; },
      close,
    };
  });
  return { log, close, connect };
}

const pgError = (code: string, message = "boom") => Object.assign(new Error(message), { code, severity: "ERROR" });

describe("runReadOnly", () => {
  it("runs inside BEGIN READ ONLY with the three limits, fetches ROW_CAP + 1 rows, always rolls back and closes", async () => {
    const f = fake();
    const r = await runReadOnly(DSN, "select 1", { connect: f.connect });
    expect(r).toMatchObject({ ok: true, columns: ["x"], rows: [[1]], rowCount: 1, truncated: false });
    expect(f.log).toEqual([...SESSION_SETUP, `ROWS(${ROW_CAP + 1}): select 1`, "ROLLBACK"]);
    expect(SESSION_SETUP).toEqual([
      "BEGIN READ ONLY", "SET LOCAL statement_timeout = '5s'", "SET LOCAL lock_timeout = '2s'", "SET LOCAL idle_in_transaction_session_timeout = '10s'",
    ]);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalled();
  });

  it("rolls back and closes when the query fails, and shows the server's message", async () => {
    const f = fake({ rows: async () => { throw pgError("42P01", 'relation "nope" does not exist'); } });
    const r = await runReadOnly(DSN, "select * from nope", { connect: f.connect });
    expect(r).toMatchObject({ ok: false, error: 'relation "nope" does not exist' });
    expect(f.log.at(-1)).toBe("ROLLBACK");
    expect(f.close).toHaveBeenCalled();
  });

  it("names a timeout and a refused write in its own words", async () => {
    expect(await runReadOnly(DSN, "select pg_sleep(9)", { connect: fake({ rows: async () => { throw pgError("57014"); } }).connect }))
      .toMatchObject({ ok: false, error: expect.stringContaining("5 seconds") });
    expect(await runReadOnly(DSN, "select nextval('s')", { connect: fake({ rows: async () => { throw pgError("25006"); } }).connect }))
      .toMatchObject({ ok: false, error: expect.stringContaining("only reads") });
  });

  it("doesn't run the query when a SET LOCAL fails", async () => {
    const f = fake({ exec: async (t) => { if (t.startsWith("SET LOCAL lock")) throw pgError("42501"); } });
    const r = await runReadOnly(DSN, "select 1", { connect: f.connect });
    expect(r.ok).toBe(false);
    expect(f.log.some((l) => l.startsWith("ROWS"))).toBe(false);
    expect(f.log.at(-1)).toBe("ROLLBACK");
  });

  it("never echoes a connection-level error (it can name the host)", async () => {
    const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${DSN.host}`), { code: "ENOTFOUND" });
    const r = await runReadOnly(DSN, "select 1", { connect: fake({ connectError: err }).connect });
    expect(r).toEqual({ ok: false, error: "Couldn't connect to the database.", durationMs: expect.any(Number) });
    expect(JSON.stringify(r)).not.toContain(DSN.host);
    expect(JSON.stringify(r)).not.toContain(DSN.password);
  });

  it("drops the connection at the hard deadline", async () => {
    const f = fake({ rows: () => new Promise(() => undefined) });
    const r = await runReadOnly(DSN, "select 1", { connect: f.connect, deadlineMs: 20 });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("took too long") });
    expect(f.close).toHaveBeenCalled();
  });

  it("reports the query's duration", async () => {
    let t = 1000;
    const clock = () => (t += 7);
    const r = await runReadOnly(DSN, "select 1", { connect: fake().connect, clock });
    expect(r).toMatchObject({ ok: true, durationMs: 7 });
  });
});

describe("row cap and truncation", () => {
  it("keeps ROW_CAP rows of ROW_CAP + 1 and marks the result truncated", () => {
    const raw = Array.from({ length: ROW_CAP + 1 }, (_, i) => [i]);
    const r = shapeRows(["n"], raw);
    expect(r.rows).toHaveLength(ROW_CAP);
    expect(r.truncated).toBe(true);
  });

  it("is not truncated at exactly ROW_CAP rows", () => {
    expect(shapeRows(["n"], Array.from({ length: ROW_CAP }, (_, i) => [i])).truncated).toBe(false);
  });

  it("stops at the payload cap", () => {
    const big = "x".repeat(CELL_CAP);
    const raw = Array.from({ length: ROW_CAP }, () => [big, big, big, big]);
    const r = shapeRows(["a", "b", "c", "d"], raw);
    expect(r.truncated).toBe(true);
    expect(JSON.stringify(r.rows).length).toBeLessThanOrEqual(PAYLOAD_CAP + 1000);
    expect(r.rows.length).toBeLessThan(ROW_CAP);
  });

  it("caps the column count", () => {
    const cols = Array.from({ length: COLUMN_CAP + 5 }, (_, i) => `c${i}`);
    const r = shapeRows(cols, [cols.map(() => 1)]);
    expect(r.columns).toHaveLength(COLUMN_CAP);
    expect(r.rows[0]).toHaveLength(COLUMN_CAP);
    expect(r.truncated).toBe(true);
  });

  it("turns driver values into JSON-safe cells, long ones cut short", () => {
    expect(toCell(null)).toBeNull();
    expect(toCell(undefined)).toBeNull();
    expect(toCell(true)).toBe(true);
    expect(toCell(3)).toBe(3);
    expect(toCell(Number.NaN)).toBe("NaN");
    expect(toCell(BigInt("12345678901234567890"))).toBe("12345678901234567890");
    expect(toCell(new Date("2026-10-16T00:00:00Z"))).toBe("2026-10-16T00:00:00.000Z");
    expect(toCell(Buffer.from([0xde, 0xad]))).toBe("\\xdead");
    expect(toCell({ a: 1, b: [2] })).toBe('{"a":1,"b":[2]}');
    const long = toCell("y".repeat(CELL_CAP + 10)) as string;
    expect(long.startsWith("y".repeat(CELL_CAP))).toBe(true);
    expect(long).toContain(`(${(CELL_CAP + 10).toLocaleString("en")} chars)`);
  });
});

describe("pgErrorText", () => {
  it("maps known codes and hides unknown non-server errors", () => {
    expect(pgErrorText(pgError("28P01", "password authentication failed for user x"))).toBe("The database refused that user or password.");
    expect(pgErrorText(Object.assign(new Error("x"), { code: "CONNECT_TIMEOUT" }))).toContain("within 5 seconds");
    expect(pgErrorText(new Error("some driver failure with postgresql://u:p@h/db"))).toBe("The query failed.");
    expect(pgErrorText("weird")).toBe("The query failed.");
  });

  it("scrubs a connection string out of a server message", () => {
    expect(pgErrorText(pgError("XX000", "oops postgresql://u:secret@h/db here"))).toBe("oops [connection string] here");
  });
});

describe("verifyReadOnly (the save test)", () => {
  // The privilege row: super, createrole, createdb, replication, write_table, create_schema, server_roles.
  const clean = [false, false, false, false, false, false, false];
  const driver = (o: { ro?: string; priv?: unknown[]; probe?: "fails" | "works" } = {}) => fake({
    rows: async (t) => t === PRIVILEGE_SQL ? { columns: [], rows: [o.priv ?? clean] } : { columns: ["ro", "user"], rows: [[o.ro ?? "on", "watchpost_ro"]] },
    exec: async (t) => { if (t === PROBE_SQL && o.probe !== "works") throw pgError("25006", "cannot execute CREATE TABLE in a read-only transaction"); },
  });

  it("passes a read-only role: forced settings hold, the probe fails, no write privilege", async () => {
    const f = driver();
    expect(await verifyReadOnly(DSN, { connect: f.connect })).toEqual({ ok: true, role: "watchpost_ro" });
    expect(f.log).toEqual([...SESSION_SETUP, "ROWS(1): SELECT current_setting('transaction_read_only'), current_user", `ROWS(1): ${PRIVILEGE_SQL}`, PROBE_SQL, "ROLLBACK"]);
    expect(f.close).toHaveBeenCalled();
  });

  it("refuses when CREATE TEMP TABLE works inside BEGIN READ ONLY", async () => {
    const r = await verifyReadOnly(DSN, { connect: driver({ probe: "works" }).connect });
    expect(r).toMatchObject({ ok: false, canWrite: true, error: expect.stringContaining(CAN_WRITE) });
  });

  it("refuses when the transaction isn't read-only after BEGIN READ ONLY", async () => {
    expect(await verifyReadOnly(DSN, { connect: driver({ ro: "off" }).connect })).toMatchObject({ ok: false, error: expect.stringContaining("read-only") });
  });

  it.each([
    [0, "superuser"], [1, "CREATEROLE"], [2, "CREATEDB"], [3, "REPLICATION"], [4, "INSERT/UPDATE/DELETE"], [5, "CREATE in a schema"], [6, "pg_write_"],
  ])("refuses a role with privilege #%i (%s)", async (i, word) => {
    const priv = clean.map((_, j) => j === i);
    const r = await verifyReadOnly(DSN, { connect: driver({ priv }).connect });
    expect(r).toMatchObject({ ok: false, canWrite: true });
    if (!r.ok) {
      expect(r.error.startsWith(CAN_WRITE)).toBe(true);
      expect(r.error).toContain(word);
    }
  });

  it("reports a refused password without the string", async () => {
    const r = await verifyReadOnly(DSN, { connect: fake({ connectError: pgError("28P01", "password authentication failed for user \"watchpost_ro\"") }).connect });
    expect(r).toEqual({ ok: false, error: "The database refused that user or password." });
  });
});
