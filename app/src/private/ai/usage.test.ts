import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ executed: [] as unknown[], afters: [] as (() => Promise<unknown>)[], fail: false }));
vi.mock("@/db/client", () => ({ db: () => ({ execute: async (q: unknown) => { if (h.fail) throw new Error("down"); h.executed.push(q); return []; } }) }));
vi.mock("next/server", () => ({ after: (fn: () => Promise<unknown>) => { h.afters.push(fn); } }));

import { CONSOLE_CLIENT, pruneUsage, recordApiCall, recordCall } from "./usage";

const render = (q: unknown) => new PgDialect().sqlToQuery(q as SQL);
beforeEach(() => { h.executed.length = 0; h.afters.length = 0; h.fail = false; });

describe("recordCall", () => {
  it("is ONE statement: usage row, agent upsert, quota upsert, key touch", async () => {
    await recordCall({
      at: new Date("2026-10-13T01:00:00Z"), keyId: "k1", client: { name: "openclaw", version: "2026.10.2", via: "mcp", userAgent: "openclaw/2026.10.2" },
      providerId: "p1", model: "gemini/gemini-3.8-flash", kind: "chat", tool: null, tokensIn: 10, tokensOut: 2, latencyMs: 812.4, status: 200, errorClass: null, stream: true,
    }, [{ providerId: "p1", scope: "all", metric: "requests:day", limit: 100, remaining: null, used: 1, resetAt: new Date("2026-10-14T00:00:00Z"), source: "own" }]);
    expect(h.executed).toHaveLength(1);
    const { sql, params } = render(h.executed[0]);
    for (const part of ["insert into ops.ai_agents", "insert into ops.ai_usage", "insert into ops.ai_quota", "update ops.api_keys set last_used_at"]) expect(sql).toContain(part);
    expect(sql).toContain("on conflict ((coalesce(key_id, '00000000-0000-0000-0000-000000000000'::uuid)), client_name)");
    expect(sql).toContain("[1:10]");
    expect(params).toContain("openclaw");
    expect(params).toContain("gemini/gemini-3.8-flash");
    expect(params).toContain(812);
    expect(JSON.parse(params.find((p) => typeof p === "string" && p.startsWith("[{")) as string)).toEqual([
      { provider_id: "p1", scope: "all", metric: "requests:day", used: 1, limit: 100, remaining: null, reset_at: "2026-10-14T00:00:00.000Z", source: "own" },
    ]);
  });
  it("stores cached and thinking tokens (0021), null when a record has none", async () => {
    const base = { at: new Date(0), keyId: "k1", client: { name: "antigravity", version: "1.3", via: "mcp" as const, userAgent: "ua" }, providerId: null, model: "gemini-3.8-flash", tool: "ask", tokensIn: 2000, tokensOut: 300, latencyMs: 4200, status: 200, errorClass: null, stream: false };
    await recordCall({ ...base, kind: "agent", tokensCached: 18000, tokensThinking: 120 }, []);
    await recordCall({ ...base, kind: "mcp" }, []);
    const a = render(h.executed[0]);
    expect(a.sql).toContain("tokens_cached, tokens_thinking)");
    expect(a.params).toEqual(expect.arrayContaining(["agent", 18000, 120]));
    const b = render(h.executed[1]);
    expect(b.params).not.toContain(18000);
    expect(b.params.filter((p) => p === null).length).toBeGreaterThan(a.params.filter((p) => p === null).length + 1);
  });
  it("the console has no key and a fixed agent name", async () => {
    await recordCall({ at: new Date(0), keyId: null, client: CONSOLE_CLIENT, providerId: "p1", model: "m", kind: "console", tool: null, tokensIn: null, tokensOut: null, latencyMs: 1, status: 200, errorClass: null, stream: false }, []);
    const { params } = render(h.executed[0]);
    expect(params).toContain("watchpost-console"); // the conflict key stays, so the console keeps one agent row
    expect(params).toContain("Watchbell console");
    expect(params).not.toContain("Watchpost console");
  });
  it("renames the console row stored before the Watchbell rename, and no other agent's name", async () => {
    await recordCall({ at: new Date(0), keyId: null, client: CONSOLE_CLIENT, providerId: "p1", model: "m", kind: "console", tool: null, tokensIn: null, tokensOut: null, latencyMs: 1, status: 200, errorClass: null, stream: false }, []);
    expect(render(h.executed[0]).sql).toContain("display_name = case when excluded.via = 'console' and a.display_name = 'Watchpost console' then excluded.display_name else a.display_name end");
  });
});

describe("pruneUsage", () => {
  it("drops usage older than 30 days and agents beyond 2,000 in one statement", async () => {
    await pruneUsage(new Date("2026-10-31T00:00:00Z"));
    const { sql, params } = render(h.executed[0]);
    expect(sql).toContain("delete from ops.ai_usage where at <");
    expect(sql).toContain("delete from ops.ai_agents");
    expect(params).toEqual(["2026-10-01T00:00:00.000Z", 2000]);
  });
});

describe("recordApiCall (REST calls: /me, /status, /status/apps, /advice)", () => {
  const key = { keyId: "k9", client: { name: "portfolio-advisor", version: "1.4", via: "x-client" as const, userAgent: "node" } };
  it("defers ONE recordCall statement to after(): usage row with kind and tool, agent upsert, key touch, no quota", async () => {
    recordApiCall(key, "status", "advice", Date.now() - 40, 200);
    expect(h.executed).toHaveLength(0);
    expect(h.afters).toHaveLength(1);
    await h.afters[0]();
    expect(h.executed).toHaveLength(1);
    const { sql, params } = render(h.executed[0]);
    for (const part of ["insert into ops.ai_agents", "insert into ops.ai_usage", "update ops.api_keys set last_used_at"]) expect(sql).toContain(part);
    expect(params).toEqual(expect.arrayContaining(["k9", "portfolio-advisor", "status", "advice", 200, "[]"]));
  });
  it("records a failed call with its status and an http_<status> error class", async () => {
    recordApiCall(key, "me", null, Date.now(), 404);
    await h.afters[0]();
    expect(render(h.executed[0]).params).toEqual(expect.arrayContaining(["me", 404, "http_404"]));
  });
  it("never throws when the write fails", async () => {
    h.fail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    recordApiCall(key, "status", "status", Date.now(), 200);
    await expect(h.afters[0]()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
