import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeDb, payloadOf } from "@/lib/data/fake-db";
import { apiKeys } from "@/private/db/schema";

const h = vi.hoisted(() => ({
  current: null as null | { db: () => unknown },
  recordEvents: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/data/events-write", () => ({ recordEvents: h.recordEvents }));

import { authLookup, createKey, KeyLimitError, KeyNameTakenError, KeyNotFoundError, keyExpiry, listKeys, listProviderOptions, revokeKey, updateKey } from "./keys-db";

const now = new Date("2026-10-13T12:00:30Z");
const dialect = new PgDialect();
const render = (q: unknown) => dialect.sqlToQuery(q as Parameters<PgDialect["sqlToQuery"]>[0]);

// authLookup uses db().execute(sql`…`), which the shared fake only counts: this stand-in records the statement.
const executeDb = (rows: unknown[]) => {
  const statements: unknown[] = [];
  const conn = {
    execute: async (q: unknown) => { statements.push(q); return rows; },
    select: () => { throw new Error("authLookup must be one execute() statement"); },
    insert: () => { throw new Error("authLookup must be one execute() statement"); },
    update: () => { throw new Error("authLookup must be one execute() statement"); },
    delete: () => { throw new Error("authLookup must be one execute() statement"); },
    transaction: () => { throw new Error("authLookup must be one execute() statement"); },
  };
  h.current = { db: () => conn };
  return statements;
};

const HASH = "a".repeat(64);
const dbRow = { id: "k1", name: "portfolio-advisor", prefix: "wp_7Hq2", scopes: ["ai:invoke", "bogus"], rate_per_min: 20, provider_id: null, model: null, hits: 1 };

beforeEach(() => {
  h.current = null;
  h.recordEvents.mockReset();
  h.recordEvents.mockResolvedValue(undefined);
});

describe("authLookup", () => {
  it("issues exactly one statement: the key lookup and this minute's rate-limit hit together", async () => {
    const statements = executeDb([dbRow]);
    const row = await authLookup(HASH, now);
    expect(statements).toHaveLength(1);
    const q = render(statements[0]);
    const text = q.sql.replace(/\s+/g, " ");
    expect(text).toContain("from ops.api_keys");
    expect(text).toContain("key_hash = $1");
    expect(text).toContain("revoked_at is null");
    expect(text).toContain("expires_at is null or expires_at >");
    expect(text).toContain("insert into ops.rate_limits");
    expect(text).toContain("'apikey:' || k.id::text");
    expect(text).toContain("on conflict (key, window_start) do update set count = ops.rate_limits.count + 1");
    expect(q.params[0]).toBe(HASH);
    // The counter's window is the minute `now` falls in; the expiry check uses `now`.
    expect(q.params).toContain("2026-10-13T12:00:00.000Z");
    expect(q.params).toContain(now.toISOString());
    expect(row).toEqual({ id: "k1", name: "portfolio-advisor", prefix: "wp_7Hq2", scopes: ["ai:invoke"], ratePerMin: 20, providerId: null, model: null, hits: 1 });
  });

  it("returns null when no active key matches (unknown, revoked or expired)", async () => {
    const statements = executeDb([]);
    expect(await authLookup(HASH, now)).toBeNull();
    expect(statements).toHaveLength(1);
  });

  it("reads the hit count whether the driver hands back a number or a string", async () => {
    executeDb([{ ...dbRow, hits: "21" }]);
    expect((await authLookup(HASH, now))?.hits).toBe(21);
  });
});

const key = (over: Record<string, unknown> = {}) => ({
  id: "k1", name: "portfolio-advisor", prefix: "wp_7Hq2", keyHash: HASH, scopes: ["ai:invoke"], ratePerMin: 20, providerId: null, model: null,
  expiresAt: null, revokedAt: null, lastUsedAt: null, createdBy: "u1", createdAt: now, ...over,
});
const values = { name: "portfolio-advisor", scopes: ["ai:invoke" as const], expiry: "90d" as const, ratePerMin: 20 };

describe("createKey", () => {
  it("stores only the hash and the prefix, returns the key once and audits without it", async () => {
    const f = fakeDb([[], []], [[key()]]);
    h.current = f;
    const { key: secret, row } = await createKey(values, "u1", now);
    expect(secret).toMatch(/^wb_[A-Za-z0-9]{40}$/);
    const ins = f.writes.find((w) => w.kind === "insert" && w.table === apiKeys)!;
    const payload = payloadOf(ins.calls)!;
    expect(payload.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.prefix).toBe(secret.slice(0, 7));
    expect(payload.expiresAt).toEqual(new Date("2027-01-11T12:00:30Z"));
    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(row.clients).toEqual([]);
    expect(f.executes()).toBe(1); // the advisory lock
    const events = h.recordEvents.mock.calls[0][0];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "action", reason: "ApiKeyCreated", actorUserId: "u1" });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(payload.keyHash as string);
  });

  it("refuses the 21st active key", async () => {
    const f = fakeDb([Array.from({ length: 20 }, (_, i) => ({ id: `k${i}`, name: `key-${i}` }))]);
    h.current = f;
    await expect(createKey(values, "u1", now)).rejects.toBeInstanceOf(KeyLimitError);
    expect(f.writes).toEqual([]);
    expect(h.recordEvents).not.toHaveBeenCalled();
  });

  it("counts only active keys: revoked and expired ones are filtered in the query", async () => {
    const f = fakeDb([[], []], [[key()]]);
    h.current = f;
    await createKey(values, "u1", now);
    const where = f.queries[0].find((c: Call) => c.method === "where")!.args[0];
    const text = render(where).sql;
    expect(text).toContain('"revoked_at" is null');
    expect(text).toContain('"expires_at" is null');
    expect(text).toContain('"expires_at" >');
  });

  it("refuses a name an active key already has", async () => {
    const f = fakeDb([[], [{ id: "k9" }]]);
    h.current = f;
    await expect(createKey(values, "u1", now)).rejects.toBeInstanceOf(KeyNameTakenError);
    expect(f.writes).toEqual([]);
  });

  it("still returns the key when the audit write fails", async () => {
    h.recordEvents.mockRejectedValue(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.current = fakeDb([[], []], [[key()]]);
    await expect(createKey(values, "u1", now)).resolves.toMatchObject({ key: expect.stringMatching(/^wb_/) });
    warn.mockRestore();
  });
});

describe("listKeys", () => {
  it("adds the detected clients of each key", async () => {
    h.current = fakeDb([[key(), key({ id: "k2", name: "other" })], [{ keyId: "k1", name: "gemini-cli" }, { keyId: "k1", name: "openclaw" }, { keyId: null, name: "console" }]]);
    const rows = await listKeys();
    expect(rows.map((r) => [r.id, r.clients])).toEqual([["k1", ["gemini-cli", "openclaw"]], ["k2", []]]);
  });
});

describe("revokeKey", () => {
  it("sets revoked_at on an active key and audits it", async () => {
    const f = fakeDb([], [[{ name: "old-test", prefix: "wp_02Za" }]]);
    h.current = f;
    await revokeKey("k1", "u1", now);
    expect(payloadOf(f.writes[0].calls)).toEqual({ revokedAt: now });
    expect(h.recordEvents.mock.calls[0][0][0]).toMatchObject({ reason: "ApiKeyRevoked", message: "API key revoked: old-test (wp_02Za)" });
  });
  it("says not found for a key that is gone or already revoked", async () => {
    h.current = fakeDb([], [[]]);
    await expect(revokeKey("k1", "u1", now)).rejects.toBeInstanceOf(KeyNotFoundError);
    expect(h.recordEvents).not.toHaveBeenCalled();
  });
});

describe("updateKey", () => {
  it("changes only the given fields and audits what changed", async () => {
    const f = fakeDb([], [[{ name: "a-key", prefix: "wp_7Hq2" }]]);
    h.current = f;
    await updateKey("k1", { ratePerMin: 30 }, "u1");
    expect(payloadOf(f.writes[0].calls)).toEqual({ ratePerMin: 30 });
    expect(h.recordEvents.mock.calls[0][0][0]).toMatchObject({ reason: "ApiKeyChanged", detail: "rate 30/min" });
  });
  it("can pin and unpin routing and clear the expiry", async () => {
    const f = fakeDb([], [[{ name: "a-key", prefix: "wp_7Hq2" }]]);
    h.current = f;
    await updateKey("k1", { providerId: null, model: null, expiresAt: null }, "u1");
    expect(payloadOf(f.writes[0].calls)).toEqual({ providerId: null, model: null, expiresAt: null });
  });
  it("does nothing for an empty patch", async () => {
    const f = fakeDb([], []);
    h.current = f;
    await updateKey("k1", {}, "u1");
    expect(f.writes).toEqual([]);
  });
  it("maps a unique-name violation to KeyNameTakenError and a missing key to not found", async () => {
    h.current = fakeDb([], [Object.assign(new Error("dup"), { cause: { code: "23505" } })]);
    await expect(updateKey("k1", { name: "taken" }, "u1")).rejects.toBeInstanceOf(KeyNameTakenError);
    h.current = fakeDb([], [[]]);
    await expect(updateKey("k1", { ratePerMin: 5 }, "u1")).rejects.toBeInstanceOf(KeyNotFoundError);
  });
});

describe("small reads", () => {
  it("keyExpiry returns the date or null", async () => {
    h.current = fakeDb([[{ expiresAt: "2027-01-01T00:00:00Z" }], [{ expiresAt: null }], []]);
    expect(await keyExpiry("k1")).toEqual(new Date("2027-01-01T00:00:00Z"));
    expect(await keyExpiry("k1")).toBeNull();
    expect(await keyExpiry("gone")).toBeNull();
  });
  it("listProviderOptions reads id, name and enabled only", async () => {
    const f = fakeDb([[{ id: "p1", name: "Google Gemini", enabled: true }]]);
    h.current = f;
    expect(await listProviderOptions()).toEqual([{ id: "p1", name: "Google Gemini", enabled: true }]);
    const select = f.queries[0].find((c) => c.method === "select")!.args[0] as Record<string, unknown>;
    expect(Object.keys(select).sort()).toEqual(["enabled", "id", "name"]);
  });
});
