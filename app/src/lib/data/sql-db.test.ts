import { beforeEach, describe, expect, it, vi } from "vitest";
import { sqlConnections } from "@/db/sql-schema";
import { open, seal } from "@/lib/crypto";
import { PRIVILEGE_SQL, PROBE_SQL, type PgConn } from "@/lib/sql/run";
import { WAKE_TEXT } from "@/lib/sql/targets";
import { fakeDb, limitOf, payloadOf } from "./fake-db";

const ENC = Buffer.alloc(32, 9).toString("base64");
const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("./cached", () => ({ aliasBook: async () => ({ db: [], app: [] }) }));
vi.mock("@/lib/sql/pg-driver", () => ({ connectPg: vi.fn() }));

import { removeSqlConnection, runAudit, runSql, saveSqlConnection, type SqlDeps } from "./sql-db";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const USER = "423e4567-e89b-42d3-a456-426614174000";
const REF = "abcdefghijklmnopqrst";
const SUPA = `postgresql://watchpost_ro.${REF}:fake-pass-not-real@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`;
const NEON = "postgresql://watchpost_ro:fake-pass-not-real@ep-quiet-dawn-123456-pooler.us-east-2.aws.neon.tech/neondb";
const NOW = new Date("2026-10-16T10:00:00Z");
const supaRow = { id: ID, kind: "supabase_project", externalId: REF, data: {}, state: "ok" };
const neonRow = (state: string) => ({ id: ID, kind: "neon_project", externalId: "proj-x", state: "idle", data: { endpoints: [{ id: "ep-quiet-dawn-123456", branchId: "b", state, pendingState: null, disabled: false, minCu: 0.25, maxCu: 0.25, lastActive: null }] } });

// A driver for a read-only role (or, with `writes`, one whose probe succeeds).
function driver(o: { writes?: boolean; rows?: unknown[][] } = {}) {
  const log: string[] = [];
  const connect = vi.fn(async (): Promise<PgConn> => ({
    exec: async (t) => {
      log.push(t);
      if (t === PROBE_SQL && !o.writes) throw Object.assign(new Error("read-only"), { code: "25006", severity: "ERROR" });
    },
    rows: async (t) => {
      log.push(t);
      if (t === PRIVILEGE_SQL) return { columns: [], rows: [[false, false, false, false, false, false, false]] };
      if (t.startsWith("SELECT current_setting")) return { columns: ["a", "b"], rows: [["on", "watchpost_ro"]] };
      return { columns: ["n"], rows: o.rows ?? [[1], [2]] };
    },
    close: async () => undefined,
  }));
  return { log, connect };
}

const deps = (connect: SqlDeps["connect"]): SqlDeps => ({ connect, alias: async () => "db-b", key: () => ENC, now: () => NOW });

let db: ReturnType<typeof fakeDb>;
beforeEach(() => {
  vi.clearAllMocks();
});

describe("saveSqlConnection", () => {
  it("refuses malformed input before any read", async () => {
    db = fakeDb([]);
    h.current = db;
    expect(await saveSqlConnection("nope", SUPA, false, USER, deps(driver().connect))).toMatchObject({ ok: false });
    expect(db.queries).toHaveLength(0);
  });

  it("tests, seals and stores a read-only role; the audit and message never hold the string", async () => {
    db = fakeDb([[supaRow]]);
    h.current = db;
    const d = driver();
    const r = await saveSqlConnection(ID, `  ${SUPA}  `, false, USER, deps(d.connect));
    expect(r).toEqual({ ok: true, message: "SQL access saved for db-b: read-only role watchpost_ro checked.", audit: { message: "SQL access saved · db-b", resourceId: ID } });
    expect(d.log).toContain(PROBE_SQL);
    expect(d.log.at(-1)).toBe("ROLLBACK");
    expect(limitOf(db.queries[0])).toBe(1);
    const w = db.writes[0];
    expect(w.kind).toBe("insert");
    expect(w.table).toBe(sqlConnections);
    const values = payloadOf(w.calls) as Record<string, string>;
    expect(values).toMatchObject({ resourceId: ID, provider: "supabase", roleName: "watchpost_ro", endpointId: null, addedBy: USER, verifiedAt: NOW });
    expect(JSON.stringify(values)).not.toContain("fake-pass-not-real");
    expect(open({ ciphertext: values.dsnCiphertext, iv: values.dsnIv }, ENC)).toBe(SUPA);
    expect(JSON.stringify(r)).not.toContain("fake-pass-not-real");
  });

  it("refuses a role that can write and stores nothing", async () => {
    db = fakeDb([[supaRow]]);
    h.current = db;
    const r = await saveSqlConnection(ID, SUPA, false, USER, deps(driver({ writes: true }).connect));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("This role can write; use a read-only role.") });
    expect(db.writes).toHaveLength(0);
  });

  it("refuses a string of another Supabase project before connecting", async () => {
    db = fakeDb([[{ ...supaRow, externalId: "zzzzzzzzzzzzzzzzzzzz" }]]);
    h.current = db;
    const d = driver();
    expect(await saveSqlConnection(ID, SUPA, false, USER, deps(d.connect))).toMatchObject({ ok: false, error: expect.stringContaining("different Supabase project") });
    expect(d.connect).not.toHaveBeenCalled();
  });

  it("asks before the save test wakes an idle Neon compute, and goes ahead once confirmed", async () => {
    db = fakeDb([[neonRow("idle")]]);
    h.current = db;
    const d = driver();
    expect(await saveSqlConnection(ID, NEON, false, USER, deps(d.connect))).toEqual({ ok: false, needsWake: true, error: `Saving tests the connection once. ${WAKE_TEXT}` });
    expect(d.connect).not.toHaveBeenCalled();
    db = fakeDb([[neonRow("idle")]]);
    h.current = db;
    expect(await saveSqlConnection(ID, NEON, true, USER, deps(d.connect))).toMatchObject({ ok: true });
    expect(payloadOf(db.writes[0].calls)).toMatchObject({ provider: "neon", endpointId: "ep-quiet-dawn-123456" });
  });

  it("says when the database isn't watched", async () => {
    db = fakeDb([[]]);
    h.current = db;
    expect(await saveSqlConnection(ID, SUPA, false, USER, deps(driver().connect))).toEqual({ ok: false, error: "That database is no longer watched." });
  });
});

describe("removeSqlConnection", () => {
  it("deletes the row and audits by alias", async () => {
    db = fakeDb([], [[{ id: ID }]]);
    h.current = db;
    expect(await removeSqlConnection(ID, { alias: async () => "db-b" })).toMatchObject({ ok: true, audit: { message: "SQL access removed · db-b", resourceId: ID } });
    db = fakeDb([], [[]]);
    h.current = db;
    expect(await removeSqlConnection(ID, { alias: async () => "db-b" })).toEqual({ ok: false, error: "This database has no SQL access." });
  });
});

describe("runSql", () => {
  const stored = (dsn: string) => {
    const s = seal(dsn, ENC);
    return { ciphertext: s.ciphertext, iv: s.iv, endpointId: dsn.includes("neon") ? "ep-quiet-dawn-123456" : null };
  };
  const admitOk = vi.fn(async () => null);

  it("runs, caps, records the last run and returns an audit with only alias, fingerprint, rows and ms", async () => {
    db = fakeDb([[supaRow], [stored(SUPA)]]);
    h.current = db;
    const d = driver({ rows: Array.from({ length: 501 }, (_, i) => [i]) });
    const text = "select * from users where email = 'someone@example.com'";
    const r = await runSql(ID, text, false, admitOk, deps(d.connect));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toMatchObject({ rowCount: 500, truncated: true });
    expect(r.audit).toEqual({ kind: "ok", resourceId: ID, message: expect.stringMatching(/^SQL run · db-b · 500 rows \(truncated\) · \d+ ms$/), detail: expect.stringMatching(/^fingerprint [0-9a-f]{12}$/) });
    expect(JSON.stringify(r.audit)).not.toMatch(/someone|example|users|fake-pass/);
    expect(admitOk).toHaveBeenCalledTimes(1);
    expect(db.writes[0]).toMatchObject({ kind: "update", table: sqlConnections });
  });

  it("asks before waking an idle Neon compute and doesn't connect or count the run", async () => {
    db = fakeDb([[neonRow("idle")], [stored(NEON)]]);
    h.current = db;
    const d = driver();
    const admit = vi.fn(async () => null);
    expect(await runSql(ID, "select 1", false, admit, deps(d.connect))).toEqual({ ok: false, error: WAKE_TEXT, needsWake: true });
    expect(d.connect).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it("runs on an idle Neon compute once confirmed, and without asking on an active one", async () => {
    for (const [state, confirm] of [["idle", true], ["active", false]] as const) {
      db = fakeDb([[neonRow(state)], [stored(NEON)]]);
      h.current = db;
      expect((await runSql(ID, "select 1", confirm, admitOk, deps(driver().connect))).ok).toBe(true);
    }
  });

  it("stops at the rate limit before connecting", async () => {
    db = fakeDb([[supaRow], [stored(SUPA)]]);
    h.current = db;
    const d = driver();
    expect(await runSql(ID, "select 1", false, async () => "Too many runs.", deps(d.connect))).toEqual({ ok: false, error: "Too many runs." });
    expect(d.connect).not.toHaveBeenCalled();
  });

  it("says when there is no connection, and when the stored one can't be opened", async () => {
    db = fakeDb([[supaRow], []]);
    h.current = db;
    expect(await runSql(ID, "select 1", false, admitOk, deps(driver().connect))).toMatchObject({ ok: false, error: expect.stringContaining("no SQL access") });
    db = fakeDb([[supaRow], [{ ...stored(SUPA), iv: Buffer.alloc(12).toString("base64") }]]);
    h.current = db;
    expect(await runSql(ID, "select 1", false, admitOk, deps(driver().connect))).toMatchObject({ ok: false, error: expect.stringContaining("can't be read") });
  });
});

describe("runAudit", () => {
  it("never carries the query text", () => {
    const text = "select 'sk_live_FAKE_secret_0000' as token";
    const ok = runAudit("db-a", ID, text, { ok: true, columns: ["token"], rows: [["x"]], rowCount: 1, truncated: false, durationMs: 12 });
    expect(ok).toEqual({ kind: "ok", resourceId: ID, message: "SQL run · db-a · 1 row · 12 ms", detail: expect.stringMatching(/^fingerprint [0-9a-f]{12}$/) });
    const err = runAudit("db-a", ID, text, { ok: false, error: "syntax error", durationMs: 3 });
    expect(err).toMatchObject({ kind: "err", message: "SQL run failed · db-a · 3 ms" });
    expect(JSON.stringify([ok, err])).not.toContain("sk_live");
  });
});
