import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEGACY_VERSION, LEGACY_VERSIONS, MODERN_VERSION, RPC, SUPPORTED_VERSIONS, decodeHeaderValue, eraOf, negotiate, parseMessage, rpcError,
  rpcResult, shapeResult,
} from "./protocol";

const meta = (v = MODERN_VERSION) => ({ "io.modelcontextprotocol/protocolVersion": v, "io.modelcontextprotocol/clientInfo": { name: "Antigravity", version: "1.2" }, "io.modelcontextprotocol/clientCapabilities": {} });

describe("parseMessage", () => {
  it("parses a request and a notification", () => {
    expect(parseMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))).toEqual({ kind: "request", id: 1, method: "tools/list", params: {} });
    expect(parseMessage(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toEqual({ kind: "notification", method: "notifications/initialized", params: {} });
  });

  it("malformed JSON → -32700", () => {
    expect(parseMessage("{nope")).toMatchObject({ kind: "error", code: RPC.parseError, id: null });
  });

  it("batches and non-2.0 objects → -32600", () => {
    expect(parseMessage("[]")).toMatchObject({ kind: "error", code: RPC.invalidRequest });
    expect(parseMessage(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]))).toMatchObject({ code: RPC.invalidRequest });
    expect(parseMessage(JSON.stringify({ id: 1, method: "ping" }))).toMatchObject({ code: RPC.invalidRequest });
    expect(parseMessage(JSON.stringify({ jsonrpc: "2.0", id: { x: 1 }, method: "ping" }))).toMatchObject({ code: RPC.invalidRequest, id: null });
  });

  it("a response sent by a client (no method) → -32600 with its id", () => {
    expect(parseMessage(JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} }))).toMatchObject({ code: RPC.invalidRequest, id: 7 });
  });

  it("params must be an object", () => {
    expect(parseMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping", params: [1] }))).toMatchObject({ code: RPC.invalidParams, id: 2 });
  });
});

describe("responses", () => {
  it("rpcResult and rpcError", () => {
    expect(rpcResult(1, { a: 1 })).toEqual({ jsonrpc: "2.0", id: 1, result: { a: 1 } });
    expect(rpcError(null, -32601, "x")).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "x" } });
    expect(rpcError("a", -32022, "x", { supported: [] })).toEqual({ jsonrpc: "2.0", id: "a", error: { code: -32022, message: "x", data: { supported: [] } } });
  });

  it("modern results carry resultType: complete; legacy ones don't", () => {
    expect(shapeResult("modern", { tools: [] })).toEqual({ resultType: "complete", tools: [] });
    expect(shapeResult("legacy", { tools: [] })).toEqual({ tools: [] });
  });
});

describe("versions", () => {
  it("supports the modern revision and the legacy ones since 2025-03-26", () => {
    expect(SUPPORTED_VERSIONS).toEqual(["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"]);
  });

  it("negotiate echoes a legacy version we speak, else offers the newest legacy one", () => {
    expect(negotiate("2025-06-18")).toBe("2025-06-18");
    expect(negotiate("2024-11-05")).toBe(LEGACY_VERSIONS[0]);
    expect(negotiate(undefined)).toBe("2025-11-25");
    expect(negotiate(MODERN_VERSION)).toBe("2025-11-25"); // initialize is legacy-only
  });
});

describe("eraOf", () => {
  const req = (method: string, params: Record<string, unknown> = {}) => ({ kind: "request" as const, id: 1, method, params });

  it("initialize is legacy, with the negotiated version", () => {
    expect(eraOf(req("initialize", { protocolVersion: "2025-06-18" }), new Headers())).toEqual({ era: "legacy", version: "2025-06-18" });
  });

  it("a legacy request without the header is 2025-03-26; with a known one it is that one", () => {
    expect(eraOf(req("tools/list"), new Headers())).toEqual({ era: "legacy", version: DEFAULT_LEGACY_VERSION });
    expect(eraOf(req("tools/list"), new Headers({ "MCP-Protocol-Version": "2025-11-25" }))).toEqual({ era: "legacy", version: "2025-11-25" });
  });

  it("an unsupported legacy header → 400 -32022 with the supported list", () => {
    const e = eraOf(req("tools/list"), new Headers({ "MCP-Protocol-Version": "1999-01-01" }));
    expect(e).toMatchObject({ era: "reject", status: 400, error: { error: { code: RPC.unsupportedVersion, data: { supported: SUPPORTED_VERSIONS, requested: "1999-01-01" } } } });
  });

  it("modern: matching headers → modern with the clientInfo from _meta", () => {
    const h = new Headers({ "MCP-Protocol-Version": MODERN_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": "get_app" });
    expect(eraOf(req("tools/call", { name: "get_app", _meta: meta() }), h)).toEqual({ era: "modern", version: MODERN_VERSION, clientInfo: { name: "Antigravity", version: "1.2" } });
  });

  it("modern: missing or mismatching headers → 400 -32020", () => {
    const bad = [
      new Headers({ "Mcp-Method": "tools/list" }),
      new Headers({ "MCP-Protocol-Version": "2025-06-18", "Mcp-Method": "tools/list" }),
      new Headers({ "MCP-Protocol-Version": MODERN_VERSION }),
      new Headers({ "MCP-Protocol-Version": MODERN_VERSION, "Mcp-Method": "ping" }),
    ];
    for (const h of bad) expect(eraOf(req("tools/list", { _meta: meta() }), h)).toMatchObject({ era: "reject", status: 400, error: { error: { code: RPC.headerMismatch } } });
    const call = new Headers({ "MCP-Protocol-Version": MODERN_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": "list_apps" });
    expect(eraOf(req("tools/call", { name: "get_app", _meta: meta() }), call)).toMatchObject({ era: "reject", error: { error: { code: RPC.headerMismatch } } });
  });

  it("modern: a base64-encoded Mcp-Name is decoded before comparing", () => {
    const h = new Headers({ "MCP-Protocol-Version": MODERN_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": `=?base64?${Buffer.from("get_app").toString("base64")}?=` });
    expect(eraOf(req("tools/call", { name: "get_app", _meta: meta() }), h)).toMatchObject({ era: "modern" });
    expect(decodeHeaderValue("plain")).toBe("plain");
  });

  it("modern: an unknown version in _meta → 400 -32022", () => {
    const h = new Headers({ "MCP-Protocol-Version": "2027-01-01", "Mcp-Method": "tools/list" });
    expect(eraOf(req("tools/list", { _meta: meta("2027-01-01") }), h)).toMatchObject({ status: 400, error: { error: { code: RPC.unsupportedVersion, data: { requested: "2027-01-01" } } } });
  });

  it("the modern header without the body metadata → -32020", () => {
    expect(eraOf(req("tools/list"), new Headers({ "MCP-Protocol-Version": MODERN_VERSION }))).toMatchObject({ era: "reject", error: { error: { code: RPC.headerMismatch } } });
  });
});
