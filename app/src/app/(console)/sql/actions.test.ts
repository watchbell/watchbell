import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const DSN = "postgresql://watchpost_ro:fake-pass-not-real@ep-quiet-dawn-123456.us-east-2.aws.neon.tech/neondb";
const owner = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };
const RUN = { columns: ["n"], rows: [[1]], rowCount: 1, truncated: false, durationMs: 5 };
const AUDIT = { kind: "ok" as const, resourceId: UUID, message: "SQL run · db-a · 1 row · 5 ms", detail: "fingerprint 0123456789ab" };

const h = vi.hoisted(() => ({
  requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), recordAction: vi.fn(),
  runSql: vi.fn(), save: vi.fn(), remove: vi.fn(), fsCollections: vi.fn(), fsQuery: vi.fn(),
  autoStatus: vi.fn(), autoCreate: vi.fn(), targetQuota: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/data/sql-db", () => ({ runSql: h.runSql, saveSqlConnection: h.save, removeSqlConnection: h.remove }));
vi.mock("@/lib/data/firestore-query-db", () => ({ firestoreCollections: h.fsCollections, queryFirestore: h.fsQuery }));
vi.mock("@/lib/data/sql-auto-db", () => ({ sqlAutoStatus: h.autoStatus, createSqlAccessAuto: h.autoCreate }));
vi.mock("@/lib/data/provider-action-db", () => ({ targetQuota: h.targetQuota }));

import { LIMITS } from "@/lib/rate-limit";
import { createSqlAccessAutoAction, deleteSqlAccess, firestoreCollectionsAction, firestoreQueryAction, runSqlAction, setSqlAccess, sqlAutoStatusAction } from "./actions";

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(owner);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  // runSql calls the action's admit hook like the real one does, right before it would connect.
  h.runSql.mockImplementation(async (_id: string, _text: string, _wake: boolean, admit: () => Promise<string | null>) => {
    const refused = await admit();
    if (refused) return { ok: false, error: refused };
    return { ok: true, result: { ok: true, ...RUN }, audit: AUDIT };
  });
  h.save.mockResolvedValue({ ok: true, message: "SQL access saved for db-a.", audit: { message: "SQL access saved · db-a", resourceId: UUID } });
  h.targetQuota.mockResolvedValue(null);
  h.autoStatus.mockResolvedValue({ can: true });
  h.autoCreate.mockResolvedValue({
    ok: true, message: "SQL access created for db-a: read-only role watchpost_ro checked and saved.",
    audit: { kind: "ok", message: "SQL access created automatically for db-a (read-only role watchpost_ro)", resourceId: UUID },
  });
  h.remove.mockResolvedValue({ ok: true, message: "SQL access removed for db-a.", audit: { message: "SQL access removed · db-a", resourceId: UUID } });
});

describe("runSqlAction", () => {
  it("is owner only: an operator is refused before the guard, the quota or a run", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await runSqlAction(UUID, "select 1", false)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.runSql).not.toHaveBeenCalled();
    expect(h.limit).not.toHaveBeenCalled();
  });

  it("refuses bad ids and flags", async () => {
    expect(await runSqlAction("nope", "select 1", false)).toMatchObject({ ok: false });
    expect(await runSqlAction(UUID, "select 1", "yes" as unknown as boolean)).toMatchObject({ ok: false });
    expect(h.runSql).not.toHaveBeenCalled();
  });

  it("runs the statement guard on the server before anything else", async () => {
    for (const bad of ["delete from t", "select 1; drop table t", "set statement_timeout = 0", "explain analyze select 1", 42 as unknown as string]) {
      const r = await runSqlAction(UUID, bad, false);
      expect(r.ok, String(bad)).toBe(false);
    }
    expect(h.runSql).not.toHaveBeenCalled();
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.recordAction).not.toHaveBeenCalled();
  });

  it("runs, audits with the alias and fingerprint, and returns the rows", async () => {
    expect(await runSqlAction(UUID, " select 1; ", false)).toEqual({ ok: true, data: { run: RUN } });
    expect(h.runSql).toHaveBeenCalledWith(UUID, "select 1;", false, expect.any(Function));
    expect(h.limit).toHaveBeenCalledWith(LIMITS.sqlRun, "mem-1");
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: AUDIT.message, detail: AUDIT.detail, resourceId: UUID, actorUserId: "user-1" });
  });

  it("allows 20 runs per 10 minutes", async () => {
    expect(LIMITS.sqlRun).toEqual({ name: "sql-run", max: 20, windowSeconds: 600 });
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 300 });
    expect(await runSqlAction(UUID, "select 1", false)).toEqual({ ok: false, error: "Too many runs. Try again in 5 minutes." });
    expect(h.recordAction).not.toHaveBeenCalled();
  });

  it("passes the Neon wake prompt through", async () => {
    h.runSql.mockResolvedValue({ ok: false, error: "Running this will wake the Neon compute (uses CU-hours). Run anyway?", needsWake: true });
    expect(await runSqlAction(UUID, "select 1", false)).toEqual({ ok: false, error: expect.stringContaining("wake the Neon compute"), data: { needsWake: true } });
  });

  it("audits a failed run too", async () => {
    h.runSql.mockResolvedValue({ ok: false, error: "syntax error", audit: { ...AUDIT, kind: "err", message: "SQL run failed · db-a" } });
    expect(await runSqlAction(UUID, "select 1", false)).toEqual({ ok: false, error: "syntax error" });
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "err", message: "SQL run failed · db-a" }));
  });
});

describe("setSqlAccess / deleteSqlAccess", () => {
  it("are owner only", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await setSqlAccess(UUID, DSN, false)).toMatchObject({ ok: false });
    expect(await deleteSqlAccess(UUID)).toMatchObject({ ok: false });
    expect(h.save).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });

  it("saves through the credential-test quota and audits without the string", async () => {
    expect(await setSqlAccess(UUID, DSN, false)).toEqual({ ok: true, message: "SQL access saved for db-a." });
    expect(h.limit).toHaveBeenCalledWith(LIMITS.credential, "mem-1");
    expect(h.save).toHaveBeenCalledWith(UUID, DSN, false, "user-1");
    expect(JSON.stringify(h.recordAction.mock.calls)).not.toContain("fake-pass");
    expect(h.refresh).toHaveBeenCalled();
  });

  it("passes the save test's wake prompt and refusals through, without auditing", async () => {
    h.save.mockResolvedValue({ ok: false, error: "Saving tests the connection once. …", needsWake: true });
    expect(await setSqlAccess(UUID, DSN, false)).toMatchObject({ ok: false, data: { needsWake: true } });
    h.save.mockResolvedValue({ ok: false, error: "This role can write; use a read-only role." });
    expect(await setSqlAccess(UUID, DSN, false)).toEqual({ ok: false, error: "This role can write; use a read-only role." });
    expect(h.recordAction).not.toHaveBeenCalled();
  });

  it("refuses an empty string and a bad id before the quota", async () => {
    expect(await setSqlAccess(UUID, "  ", false)).toMatchObject({ ok: false, fieldErrors: { dsn: expect.any(String) } });
    expect(await setSqlAccess("x", DSN, false)).toMatchObject({ ok: false });
    expect(h.limit).not.toHaveBeenCalled();
  });

  it("removes and audits", async () => {
    expect(await deleteSqlAccess(UUID)).toEqual({ ok: true, message: "SQL access removed for db-a." });
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "SQL access removed · db-a", resourceId: UUID, actorUserId: "user-1" });
  });
});

describe("Firestore actions", () => {
  it("are owner only", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await firestoreCollectionsAction(UUID)).toMatchObject({ ok: false });
    expect(await firestoreQueryAction(UUID, {})).toMatchObject({ ok: false });
    expect(h.fsCollections).not.toHaveBeenCalled();
    expect(h.fsQuery).not.toHaveBeenCalled();
  });

  it("lists collections through the Firestore quota", async () => {
    h.fsCollections.mockResolvedValue({ ok: true, ids: ["orders"], more: false });
    expect(await firestoreCollectionsAction(UUID)).toEqual({ ok: true, data: { collections: ["orders"], more: false } });
    expect(h.limit).toHaveBeenCalledWith(LIMITS.firestoreQuery, "mem-1");
  });

  it("queries and audits", async () => {
    const run = { docs: [], reads: 1, truncated: false, durationMs: 9 };
    h.fsQuery.mockResolvedValue({ ok: true, result: run, audit: { ...AUDIT, message: "Firestore query · db-c · 0 docs · 1 read · 9 ms" } });
    expect(await firestoreQueryAction(UUID, { collection: "orders" })).toEqual({ ok: true, data: { run } });
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ message: "Firestore query · db-c · 0 docs · 1 read · 9 ms" }));
  });
});

describe("Set up automatically (Supabase automatic SQL access)", () => {
  it("both actions are owner only: nothing is checked, probed or created for an operator", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await sqlAutoStatusAction(UUID)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(await createSqlAccessAutoAction(UUID)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.autoStatus).not.toHaveBeenCalled();
    expect(h.autoCreate).not.toHaveBeenCalled();
    expect(h.targetQuota).not.toHaveBeenCalled();
    expect(h.recordAction).not.toHaveBeenCalled();
  });

  it("refuse a bad id before any quota or call", async () => {
    expect(await sqlAutoStatusAction("nope")).toMatchObject({ ok: false });
    expect(await createSqlAccessAutoAction(42 as unknown as string)).toMatchObject({ ok: false });
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.targetQuota).not.toHaveBeenCalled();
    expect(h.autoCreate).not.toHaveBeenCalled();
  });

  it("the status check shares the credential-test quota", async () => {
    expect(await sqlAutoStatusAction(UUID)).toEqual({ ok: true, data: { can: true } });
    expect(h.limit).toHaveBeenCalledWith(LIMITS.credential, "mem-1");
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 120 });
    expect(await sqlAutoStatusAction(UUID)).toMatchObject({ ok: false, error: expect.stringContaining("Too many") });
    expect(h.autoStatus).toHaveBeenCalledTimes(1);
  });

  it("creating takes the provider-action quota and the per-target cooldown", async () => {
    h.targetQuota.mockResolvedValue("That was just done. Wait a minute before trying again.");
    expect(await createSqlAccessAutoAction(UUID)).toEqual({ ok: false, error: "That was just done. Wait a minute before trying again." });
    expect(h.targetQuota).toHaveBeenCalledWith("mem-1", "sql-auto", UUID);
    expect(h.autoCreate).not.toHaveBeenCalled();
    expect(h.recordAction).not.toHaveBeenCalled();
  });

  it("creates, audits the owner's sentence and returns no password or string", async () => {
    const r = await createSqlAccessAutoAction(UUID);
    expect(r).toEqual({ ok: true, message: "SQL access created for db-a: read-only role watchpost_ro checked and saved." });
    expect(h.autoCreate).toHaveBeenCalledWith(UUID, "user-1");
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "SQL access created automatically for db-a (read-only role watchpost_ro)", resourceId: UUID, actorUserId: "user-1" });
    expect(JSON.stringify(r)).not.toMatch(/postgres(ql)?:\/\//);
    expect(h.refresh).toHaveBeenCalled();
  });

  it("audits a failed attempt that reached the database, and passes the reason through", async () => {
    h.autoCreate.mockResolvedValue({ ok: false, error: "The new role didn't pass the read-only check…", audit: { kind: "err", message: "SQL access automatic setup failed · db-a", resourceId: UUID } });
    expect(await createSqlAccessAutoAction(UUID)).toEqual({ ok: false, error: "The new role didn't pass the read-only check…" });
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "err", message: "SQL access automatic setup failed · db-a" }));
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
