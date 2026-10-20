import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./sql-db", () => ({ watched: vi.fn(), saveSqlConnection: vi.fn() }));
vi.mock("@/lib/data/provider-action-db", () => ({ loadTarget: vi.fn() }));
vi.mock("./cached", () => ({ aliasBook: async () => ({ db: [], app: [] }) }));

import { CAN_WRITE, pgErrorText } from "@/lib/sql/run";
import { rollbackScript, setupScript } from "@/lib/sql/supabase-auto";
import { type AutoDeps, createSqlAccessAuto, SAVE_ATTEMPTS, sqlAutoStatus } from "./sql-auto-db";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const USER = "423e4567-e89b-42d3-a456-426614174000";
const REF = "abcdefghijklmnopqrst";
const HOST = "aws-0-ap-southeast-1.pooler.supabase.com";
const PW = "fakeGeneratedPassword-0123456789_abcdefghij"; // 43 chars, test only
const VERIFIER = `SCRAM-SHA-256$4096:${Buffer.alloc(16, 1).toString("base64")}$${Buffer.alloc(32, 2).toString("base64")}:${Buffer.alloc(32, 3).toString("base64")}`;

function setup(over: Partial<AutoDeps> = {}) {
  const deps: AutoDeps = {
    target: vi.fn(async () => ({ ref: REF, token: "tok", paused: false })),
    pooler: vi.fn(async () => ({ ok: true as const, data: [{ database_type: "PRIMARY", db_host: HOST, db_name: "postgres" }] })),
    run: vi.fn(async () => ({ ok: true as const, data: null })),
    access: vi.fn(async () => ({ can: true as const })),
    save: vi.fn(async () => ({ ok: true as const, message: "saved", audit: { message: "SQL access saved · db-a", resourceId: ID } })),
    alias: vi.fn(async () => "db-a"),
    password: () => PW,
    verifier: vi.fn(() => VERIFIER),
    sleep: vi.fn(async () => undefined),
    ...over,
  };
  return deps;
}

const queries = (d: AutoDeps) => (d.run as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2] as string);

beforeEach(() => vi.clearAllMocks());

describe("createSqlAccessAuto", () => {
  it("runs the one setup script, saves the pooler string through the normal check, and audits without the password", async () => {
    const d = setup();
    const r = await createSqlAccessAuto(ID, USER, d);
    expect(r).toEqual({
      ok: true, message: "SQL access created for db-a: read-only role watchpost_ro checked and saved.",
      audit: { kind: "ok", message: "SQL access created automatically for db-a (read-only role watchpost_ro)", resourceId: ID },
    });
    expect(d.verifier).toHaveBeenCalledWith(PW);
    expect(d.run).toHaveBeenCalledTimes(1);
    expect(d.run).toHaveBeenCalledWith("tok", REF, setupScript(VERIFIER), false);
    expect(queries(d).join("\n")).not.toContain(PW);
    expect(d.save).toHaveBeenCalledWith(ID, `postgresql://watchpost_ro.${REF}:${PW}@${HOST}:6543/postgres?sslmode=require`, USER);
    expect(JSON.stringify(r)).not.toContain(PW);
  });

  it("changes nothing when the pooler host can't be read or isn't the shared pooler", async () => {
    const d = setup({ pooler: vi.fn(async () => ({ ok: false as const, kind: "scope" as const, missing: ["database_pooling_config_read"], error: "Missing permission" })) });
    const r = await createSqlAccessAuto(ID, USER, d);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("database_pooling_config_read") });
    expect(d.run).not.toHaveBeenCalled();
    const d2 = setup({ pooler: vi.fn(async () => ({ ok: true as const, data: [{ database_type: "PRIMARY", db_host: `db.${REF}.supabase.co` }] })) });
    expect(await createSqlAccessAuto(ID, USER, d2)).toMatchObject({ ok: false });
    expect(d2.run).not.toHaveBeenCalled();
    expect(d2.save).not.toHaveBeenCalled();
  });

  it("explains a missing database_write and saves nothing", async () => {
    const d = setup({ run: vi.fn(async () => ({ ok: false as const, kind: "scope" as const, status: 403, missing: ["database_write"], error: "Missing permission: database_write." })) });
    const r = await createSqlAccessAuto(ID, USER, d);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Database: Read-write"), audit: { kind: "err" } });
    expect(d.save).not.toHaveBeenCalled();
    expect(d.run).toHaveBeenCalledTimes(1); // a refused script changed nothing: no rollback
  });

  it("on a failed read-only check: refuses, revokes the grants through the same endpoint and never drops", async () => {
    const d = setup({ save: vi.fn(async () => ({ ok: false as const, error: `${CAN_WRITE} It has: INSERT/UPDATE/DELETE on a table.` })) });
    const r = await createSqlAccessAuto(ID, USER, d);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Its grants were revoked"), audit: { kind: "err", message: "SQL access automatic setup failed · db-a" } });
    expect(d.save).toHaveBeenCalledTimes(1); // a write privilege isn't retried
    expect(queries(d)).toEqual([setupScript(VERIFIER), rollbackScript()]);
    expect(queries(d).join("\n")).not.toMatch(/\bdrop\b/i);
    expect(JSON.stringify(r)).not.toContain(PW);
  });

  it("says how to clean up by hand when the revoke fails too", async () => {
    const run = vi.fn(async (_t: string, _r: string, q: string) => (q === rollbackScript() ? { ok: false as const, kind: "transient" as const, status: 500, error: "x" } : { ok: true as const, data: null }));
    const d = setup({ run, save: vi.fn(async () => ({ ok: false as const, error: "BEGIN READ ONLY didn't make the transaction read-only" })) });
    expect(await createSqlAccessAuto(ID, USER, d)).toMatchObject({ ok: false, error: expect.stringContaining("nologin") });
  });

  it("tries a sign-in failure again (the pooler may not see the new password yet), then succeeds", async () => {
    const save = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: pgErrorText({ code: "28P01" }) })
      .mockResolvedValueOnce({ ok: true, message: "saved" });
    const d = setup({ save });
    expect(await createSqlAccessAuto(ID, USER, d)).toMatchObject({ ok: true });
    expect(save).toHaveBeenCalledTimes(2);
    expect(d.sleep).toHaveBeenCalledTimes(1);
    expect(queries(d)).toEqual([setupScript(VERIFIER)]);
  });

  it("gives up after a few sign-in failures and rolls back", async () => {
    const d = setup({ save: vi.fn(async () => ({ ok: false as const, error: pgErrorText({ code: "28P01" }) })) });
    expect(await createSqlAccessAuto(ID, USER, d)).toMatchObject({ ok: false });
    expect(d.save).toHaveBeenCalledTimes(SAVE_ATTEMPTS);
    expect(queries(d)).toEqual([setupScript(VERIFIER), rollbackScript()]);
  });

  it("rolls back when the setup call got no answer (it may have run)", async () => {
    const run = vi.fn(async (_t: string, _r: string, q: string) => (q === rollbackScript() ? { ok: true as const, data: null } : { ok: false as const, kind: "transient" as const, error: "Supabase didn't answer within 10 seconds." }));
    const d = setup({ run });
    expect(await createSqlAccessAuto(ID, USER, d)).toMatchObject({ ok: false, error: expect.stringContaining("revoked"), audit: { kind: "err" } });
    expect(d.save).not.toHaveBeenCalled();
    expect(queries(d)).toEqual([setupScript(VERIFIER), rollbackScript()]);
  });

  it("refuses a bad id, an unwatched project and a paused one before any call", async () => {
    const d = setup();
    expect(await createSqlAccessAuto("nope", USER, d)).toMatchObject({ ok: false });
    expect(d.target).not.toHaveBeenCalled();
    const gone = setup({ target: vi.fn(async () => null) });
    expect(await createSqlAccessAuto(ID, USER, gone)).toMatchObject({ ok: false, error: expect.stringContaining("no longer watched") });
    const paused = setup({ target: vi.fn(async () => ({ ref: REF, token: "tok", paused: true })) });
    expect(await createSqlAccessAuto(ID, USER, paused)).toMatchObject({ ok: false, error: expect.stringContaining("paused") });
    for (const x of [d, gone, paused]) {
      expect(x.pooler).not.toHaveBeenCalled();
      expect(x.run).not.toHaveBeenCalled();
    }
  });
});

describe("sqlAutoStatus", () => {
  it("asks the provider only for a watched, active project", async () => {
    const d = setup();
    expect(await sqlAutoStatus(ID, d)).toEqual({ can: true });
    expect(d.access).toHaveBeenCalledWith("tok", REF);
    expect(d.run).not.toHaveBeenCalled();
    const paused = setup({ target: vi.fn(async () => ({ ref: REF, token: "tok", paused: true })) });
    expect(await sqlAutoStatus(ID, paused)).toMatchObject({ can: false, reason: "other" });
    expect(paused.access).not.toHaveBeenCalled();
    expect(await sqlAutoStatus("nope", d)).toMatchObject({ can: false });
  });
});
