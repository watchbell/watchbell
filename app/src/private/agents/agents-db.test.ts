import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, payloadOf } from "@/lib/data/fake-db";
import { aiAgents } from "@/private/db/schema";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown }, recordEvents: vi.fn() }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/data/events-write", () => ({ recordEvents: h.recordEvents }));

import { forgetAgent, listAgents, pruneAgents, renameAgent } from "./agents-db";

const now = new Date("2026-10-13T12:00:00Z");
const dialect = new PgDialect();
const render = (q: unknown) => dialect.sqlToQuery(q as Parameters<PgDialect["sqlToQuery"]>[0]);

const agent = (over: Record<string, unknown> = {}) => ({
  id: "a1", displayName: null, clientName: "gemini-cli", clientVersion: "0.9.0", via: "mcp", userAgent: "GeminiCLI/0.9.0", keyId: "k1", keyName: "laptop-agents",
  keyRevokedAt: null, firstSeenAt: new Date("2026-10-13T07:22:00Z"), lastSeenAt: new Date("2026-10-13T11:56:00Z"), requests: 37, recent: ["list_apps"], ...over,
});

beforeEach(() => {
  h.current = null;
  h.recordEvents.mockReset();
  h.recordEvents.mockResolvedValue(undefined);
});

describe("listAgents", () => {
  it("joins the per-agent counters from one grouped ai_usage query", async () => {
    const f = fakeDb([
      [agent(), agent({ id: "a2", clientName: "curl", keyId: "k2", keyName: "old-test", keyRevokedAt: new Date("2026-10-12T00:00:00Z"), lastSeenAt: new Date("2026-10-13T11:59:00Z") }), agent({ id: "a3", clientName: "console", keyId: null, keyName: null, displayName: "Watchpost console", lastSeenAt: new Date("2026-10-13T09:00:00Z") })],
      [{ agentId: "a1", requests: 12, tokens: 0, mcp1h: 6, mcp24h: 11, chat24h: 0 }, { agentId: "a3", requests: 9, tokens: 6100, mcp1h: 0, mcp24h: 0, chat24h: 9 }],
    ]);
    h.current = f;
    const rows = await listAgents(now);
    expect(f.queries).toHaveLength(2); // agents + one grouped usage read, no per-agent queries
    expect(rows.map((r) => [r.id, r.name, r.status])).toEqual([["a1", "gemini-cli", "active"], ["a2", "curl", "revoked"], ["a3", "Watchpost console", "idle"]]);
    expect(rows[0]).toMatchObject({ requests: 37, requests24h: 12, tokens24h: 0, mcpCalls1h: 6, mcpCalls24h: 11, uses: ["MCP"], keyName: "laptop-agents" });
    expect(rows[1]).toMatchObject({ requests24h: 0, mcpCalls24h: 0, uses: [] });
    expect(rows[2]).toMatchObject({ keyId: null, keyName: null, tokens24h: 6100, uses: ["Chat completions"] });
  });

  it("an agent of a key that isn't revoked is not 'revoked', and the console agent never is", async () => {
    h.current = fakeDb([[agent({ keyId: null, keyName: null, keyRevokedAt: null })], []]);
    expect((await listAgents(now))[0].status).toBe("active");
  });

  it("caps the list at 2,000 rows (R7)", async () => {
    const f = fakeDb([[], []]);
    h.current = f;
    await listAgents(now);
    expect(f.queries[0].find((c) => c.method === "limit")?.args[0]).toBe(2000);
  });
});

describe("renameAgent / forgetAgent", () => {
  it("sets display_name, or clears it for an empty name, and audits", async () => {
    const f = fakeDb([], [[{ clientName: "openclaw" }], [{ clientName: "openclaw" }]]);
    h.current = f;
    expect(await renameAgent("a1", "  My claw ", "u1")).toBe(true);
    expect(payloadOf(f.writes[0].calls)).toEqual({ displayName: "My claw" });
    expect(await renameAgent("a1", "   ", "u1")).toBe(true);
    expect(payloadOf(f.writes[1].calls)).toEqual({ displayName: null });
    expect(h.recordEvents).toHaveBeenCalledTimes(2);
  });
  it("forget deletes the row; a missing row says false and audits nothing", async () => {
    const f = fakeDb([], [[{ clientName: "curl" }], []]);
    h.current = f;
    expect(await forgetAgent("a1", "u1")).toBe(true);
    expect(f.writes[0]).toMatchObject({ kind: "delete", table: aiAgents });
    expect(await forgetAgent("a1", "u1")).toBe(false);
    expect(h.recordEvents).toHaveBeenCalledTimes(1);
  });
});

describe("pruneAgents", () => {
  it("is one delete that keeps the 2,000 most recently seen agents", async () => {
    const statements: unknown[] = [];
    h.current = { db: () => ({ execute: async (q: unknown) => { statements.push(q); return []; } }) };
    await pruneAgents();
    expect(statements).toHaveLength(1);
    const q = render(statements[0]);
    expect(q.sql.replace(/\s+/g, " ")).toContain("delete from ops.ai_agents where id in (select id from ops.ai_agents order by last_seen_at desc offset $1)");
    expect(q.params).toEqual([2000]);
  });
});
