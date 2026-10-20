import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ executed: [] as unknown[] }));
vi.mock("@/db/client", () => ({ db: () => ({ execute: async (q: unknown) => { h.executed.push(q); return []; } }) }));

import { clientLabel, forgetClients, mcpClient, recordMcpCall, rememberClient, rememberedClient, sanitizeName } from "./agent";

const fromHeaders = { name: "node", version: "22", via: "user-agent" as const, userAgent: "node/22" };

beforeEach(() => {
  h.executed.length = 0;
  forgetClients();
});

describe("mcpClient (R6)", () => {
  it("clientInfo { Antigravity, 1.2 } → agent antigravity via mcp", () => {
    expect(mcpClient(fromHeaders, { name: "Antigravity", version: "1.2" })).toEqual({ name: "antigravity", version: "1.2", via: "mcp", userAgent: "node/22" });
  });

  it("keeps the header-detected client when clientInfo has no usable name", () => {
    expect(mcpClient(fromHeaders, null)).toBe(fromHeaders);
    expect(mcpClient(fromHeaders, { name: "🙂" })).toBe(fromHeaders);
    expect(mcpClient(fromHeaders, { name: 42 })).toBe(fromHeaders);
  });

  it("sanitises names and versions like T2's detector", () => {
    expect(sanitizeName("Gemini CLI")).toBe("gemini-cli");
    expect(mcpClient(fromHeaders, { name: "x".repeat(80), version: "1.0 beta<script>" })).toMatchObject({ name: "x".repeat(40), version: "1.0betascript" });
    expect(clientLabel({ ...fromHeaders, name: "antigravity", version: "1.2" })).toBe("antigravity/1.2");
    expect(clientLabel({ ...fromHeaders, name: "antigravity", version: "" })).toBe("antigravity");
  });

  it("remembers the last MCP client per key (best effort, bounded)", () => {
    rememberClient("k1", fromHeaders); // not mcp: ignored
    expect(rememberedClient("k1")).toBeNull();
    rememberClient("k1", { name: "antigravity", version: "1.2", via: "mcp", userAgent: "" });
    expect(rememberedClient("k1")).toEqual({ name: "antigravity", version: "1.2" });
    for (let i = 0; i < 150; i++) rememberClient(`x${i}`, { name: "a", version: "", via: "mcp", userAgent: "" });
    expect(rememberedClient("k1")).toBeNull();
    expect(rememberedClient("x149")).not.toBeNull();
  });
});

describe("recordMcpCall", () => {
  const rec = {
    at: new Date("2026-10-13T03:00:00Z"), keyId: "k1", client: { name: "antigravity", version: "1.2", via: "mcp" as const, userAgent: "ua" },
    providerId: null, model: null, kind: "mcp" as const, tool: "get_app", tokensIn: null, tokensOut: null, latencyMs: 12.4, status: 200, errorClass: null, stream: false,
  };

  it("one statement: key last_used_at, agent upsert with the tool in recent, usage row kind mcp", async () => {
    await recordMcpCall(rec);
    expect(h.executed).toHaveLength(1);
    const { sql, params } = new PgDialect().sqlToQuery(h.executed[0] as SQL);
    expect(sql).toContain("update ops.api_keys set last_used_at");
    expect(sql).toContain("on conflict ((coalesce(key_id, '00000000-0000-0000-0000-000000000000'::uuid)), client_name)");
    expect(sql).toContain("[1:10]");
    expect(sql).toContain("insert into ops.ai_usage");
    expect(params).toEqual(expect.arrayContaining(["k1", "antigravity", "1.2", "mcp", "get_app", 12, 200]));
    expect(sql).toContain("insert into ops.ai_quota"); // it is Task 3's shared recordCall (stage 5c integration)
  });

  it("uses Task 2's name/version rules", async () => {
    const detect = await import("@/private/agents/detect");
    expect(sanitizeName).toBe(detect.sanitizeName);
    expect(mcpClient(fromHeaders, { name: "Gemini CLI", version: "0.63.0" })).toEqual(detect.detectClient(new Headers({ "user-agent": "node/22" }), { name: "Gemini CLI", version: "0.63.0" }));
  });

  it("records nothing without a key or a client", async () => {
    await recordMcpCall({ ...rec, keyId: null });
    await recordMcpCall({ ...rec, client: null });
    expect(h.executed).toHaveLength(0);
  });
});
