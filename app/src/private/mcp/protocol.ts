// MCP over Streamable HTTP, JSON-RPC 2.0 framing (pure).
//
// Verified 2026-10-13 against modelcontextprotocol.io/specification (latest revision 2026-07-28, plus the legacy
// 2025-11-25 / 2025-06-18 / 2025-03-26 pages):
// - Every client message is its own HTTP POST with ONE JSON-RPC request or notification (no batches). A notification
//   the server accepts gets 202 with no body. A request gets `application/json` (we never open an SSE stream).
// - 2026-07-28 ("modern") has no `initialize` and no sessions: every request carries
//   `params._meta["io.modelcontextprotocol/protocolVersion" | ".../clientInfo" | ".../clientCapabilities"]`, mirrored
//   in the `MCP-Protocol-Version`, `Mcp-Method` and (tools/call) `Mcp-Name` headers. A header that is missing or does
//   not match the body → 400 + JSON-RPC -32020 HeaderMismatch. An unsupported version → 400 + -32022 with
//   `data: { supported, requested }`. An unknown method → 404 + -32601. `server/discover` is mandatory. Results carry
//   `resultType: "complete"`.
// - Legacy revisions (≤ 2025-11-25) open with `initialize` (we negotiate the version and answer statelessly: no
//   `Mcp-Session-Id`), then send `MCP-Protocol-Version` on later requests (absent = 2025-03-26; an unsupported one → 400).
// - GET and DELETE on the endpoint → 405 (no standalone SSE stream, no sessions). An `Origin` header that is present
//   and not ours → 403.
// This server is dual-era: it serves modern clients statelessly and legacy clients (Antigravity, Gemini CLI, OpenClaw,
// the MCP Inspector) through `initialize` without keeping a session.

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const SUPPORTED_VERSIONS: readonly string[] = [MODERN_VERSION, ...LEGACY_VERSIONS];
// What a legacy request without MCP-Protocol-Version is taken to speak (spec: "MAY treat ... as 2025-03-26").
export const DEFAULT_LEGACY_VERSION = "2025-03-26";

export const META_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT = "io.modelcontextprotocol/clientInfo";

export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
  // Implementation-defined (JSON-RPC server-error range): the key lacks a scope a tool needs.
  forbidden: -32001,
} as const;

export type JsonRpcId = string | number;
export type JsonRpcRequest = { kind: "request"; id: JsonRpcId; method: string; params: Record<string, unknown> };
export type JsonRpcNotification = { kind: "notification"; method: string; params: Record<string, unknown> };
export type JsonRpcError = { kind: "error"; id: JsonRpcId | null; code: number; message: string };
export type Parsed = JsonRpcRequest | JsonRpcNotification | JsonRpcError;

export type RpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId | null; error: { code: number; message: string; data?: unknown } };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const validId = (v: unknown): v is JsonRpcId => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

// Raw body text → one message. Malformed JSON → -32700; a batch or a non-request shape → -32600.
export function parseMessage(text: string): Parsed {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "error", id: null, code: RPC.parseError, message: "Parse error: the body is not valid JSON." };
  }
  if (Array.isArray(json)) return { kind: "error", id: null, code: RPC.invalidRequest, message: "Batches are not supported: send one JSON-RPC message per POST." };
  if (!isObj(json) || json.jsonrpc !== "2.0") return { kind: "error", id: null, code: RPC.invalidRequest, message: "Invalid request: expected a JSON-RPC 2.0 object." };
  const id = "id" in json ? json.id : undefined;
  if (id !== undefined && !validId(id)) return { kind: "error", id: null, code: RPC.invalidRequest, message: "Invalid request: id must be a string or a number." };
  if (typeof json.method !== "string" || json.method.length === 0 || json.method.length > 100) {
    // A JSON-RPC *response* (result/error, no method) is something a client must not send.
    return { kind: "error", id: id ?? null, code: RPC.invalidRequest, message: "Invalid request: method is missing." };
  }
  if (json.params !== undefined && !isObj(json.params)) {
    return { kind: "error", id: id ?? null, code: RPC.invalidParams, message: "Invalid params: params must be an object." };
  }
  const params = (json.params as Record<string, unknown> | undefined) ?? {};
  return id === undefined ? { kind: "notification", method: json.method, params } : { kind: "request", id, method: json.method, params };
}

export function rpcResult(id: JsonRpcId, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

// initialize: echo the client's version when we speak it, else offer our newest legacy one (the client decides).
export function negotiate(clientVersion: unknown): string {
  return typeof clientVersion === "string" && (LEGACY_VERSIONS as readonly string[]).includes(clientVersion) ? clientVersion : LEGACY_VERSIONS[0];
}

// The request's `_meta` (modern era), if any.
export function metaOf(params: Record<string, unknown>): Record<string, unknown> | null {
  return isObj(params._meta) ? params._meta : null;
}

export type Era =
  | { era: "modern"; version: string; clientInfo: { name?: unknown; version?: unknown } | null }
  | { era: "legacy"; version: string }
  | { era: "reject"; status: number; error: RpcResponse };

// Decide how to serve one request from its headers and body. Modern = the body declares a protocol version in _meta.
export function eraOf(msg: JsonRpcRequest | JsonRpcNotification, headers: Headers): Era {
  const id = msg.kind === "request" ? msg.id : null;
  const header = headers.get("mcp-protocol-version")?.trim() ?? null;
  const meta = metaOf(msg.params);
  const declared = meta?.[META_VERSION];
  if (typeof declared === "string" && msg.method !== "initialize") {
    if (declared !== MODERN_VERSION) {
      return { era: "reject", status: 400, error: rpcError(id, RPC.unsupportedVersion, "Unsupported protocol version", { supported: SUPPORTED_VERSIONS, requested: declared }) };
    }
    const mismatch = headerMismatch(msg, headers, header, declared);
    if (mismatch) return { era: "reject", status: 400, error: rpcError(id, RPC.headerMismatch, mismatch) };
    const ci = meta?.[META_CLIENT];
    return { era: "modern", version: declared, clientInfo: isObj(ci) ? ci : null };
  }
  if (msg.method === "initialize") return { era: "legacy", version: negotiate(msg.params.protocolVersion) };
  if (header === null) return { era: "legacy", version: DEFAULT_LEGACY_VERSION };
  if (header === MODERN_VERSION) {
    // A modern header without the body metadata it mirrors.
    return { era: "reject", status: 400, error: rpcError(id, RPC.headerMismatch, `Header mismatch: _meta["${META_VERSION}"] is missing from the body.`) };
  }
  if (!(LEGACY_VERSIONS as readonly string[]).includes(header)) {
    return { era: "reject", status: 400, error: rpcError(id, RPC.unsupportedVersion, "Unsupported protocol version", { supported: SUPPORTED_VERSIONS, requested: header.slice(0, 40) }) };
  }
  return { era: "legacy", version: header };
}

// =?base64?…?= sentinel (Mcp-Name, Mcp-Param-*) → the plain value; null when the encoding is broken.
export function decodeHeaderValue(v: string): string | null {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try {
    return Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return null;
  }
}

function headerMismatch(msg: JsonRpcRequest | JsonRpcNotification, headers: Headers, version: string | null, declared: string): string | null {
  if (version === null) return "Header mismatch: MCP-Protocol-Version header is missing.";
  if (version !== declared) return "Header mismatch: MCP-Protocol-Version header does not match the body.";
  if (msg.kind === "notification") return null; // header rules for notification POSTs are not defined by 2026-07-28
  const method = headers.get("mcp-method");
  if (method === null) return "Header mismatch: Mcp-Method header is missing.";
  if (method !== msg.method) return "Header mismatch: Mcp-Method header does not match the body.";
  if (msg.method === "tools/call" || msg.method === "resources/read" || msg.method === "prompts/get") {
    const raw = headers.get("mcp-name");
    if (raw === null) return "Header mismatch: Mcp-Name header is missing.";
    const name = decodeHeaderValue(raw);
    const body = msg.params.name ?? msg.params.uri;
    if (name === null || name !== body) return "Header mismatch: Mcp-Name header does not match the body.";
  }
  return null;
}

// What a modern result looks like (adds resultType); legacy results are left as they are.
export function shapeResult(era: "modern" | "legacy", result: Record<string, unknown>): Record<string, unknown> {
  return era === "modern" ? { resultType: "complete", ...result } : result;
}
