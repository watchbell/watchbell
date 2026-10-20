import "server-only";
import { MCP_COPY } from "@/lib/copy/edition";
import { after } from "next/server";
import { type ApiKeyContext, authenticateApiKey } from "@/private/auth/api-key";
import { mcpClient, recordMcpCall, rememberClient, rememberedClient } from "./agent";
import {
  type JsonRpcRequest, RPC, type RpcResponse, SUPPORTED_VERSIONS, eraOf, parseMessage, rpcError, rpcResult, shapeResult,
} from "./protocol";
import { findTool, toolsFor } from "./tools";

// POST /api/v1/mcp: the MCP server for agents (Antigravity, Gemini CLI, OpenClaw). Stateless Streamable HTTP, JSON
// answers only (no SSE, no Mcp-Session-Id). Order: Origin check → console API key with read:status (HTTP 401/403/429
// before any JSON-RPC) → one JSON-RPC message → era (protocol.ts) → method. Each request is recorded as an MCP call of
// the detected agent after the response (kind 'mcp', tool = the tool name or the method).

export const SERVER_INFO = { name: "watchbell", title: "Watchbell", version: "5c" } as const;
export const MAX_BODY_BYTES = 64 * 1024;

export const INSTRUCTIONS = [
  "Watchbell is the owner's operations console (apps on Vercel, uptime monitors, databases, alerts, logs).",
  "Read with list_apps, get_app, list_alerts, list_monitors, recent_events, recent_logs, list_databases and get_advisor.",
  "Database names are aliases (db-a, db-b, …) and emails, hosts and secrets are hidden on purpose; don't ask for them.",
  "With the write:notes scope: answer the owner's questions (list_pending_questions → answer_question) and post a",
  "short note with submit_ai_note only when something needs attention. Both need the `model` you run as.",
  ...MCP_COPY.instructionsTail,
].join(" ");

const CAPABILITIES = { tools: { listChanged: false } };

function json(body: RpcResponse | null, status = 200): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (body === null) return new Response(null, { status, headers });
  return Response.json(body, { status, headers });
}

// DNS-rebinding guard (spec MUST): an Origin that is present must be this site's own.
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") return origin === null;
  const allowed = new Set<string>();
  try { allowed.add(new URL(req.url).origin); } catch { /* relative URL: no own origin */ }
  for (const v of [process.env.NEXT_PUBLIC_SITE_URL, process.env.SITE_URL]) {
    if (!v) continue;
    try { allowed.add(new URL(v).origin); } catch { /* ignore a malformed env value */ }
  }
  return allowed.has(origin);
}

async function readBody(req: Request): Promise<string | null> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) return null;
  const text = await req.text();
  return Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES ? null : text;
}

export async function handleMcp(req: Request): Promise<Response> {
  const started = Date.now();
  if (!originAllowed(req)) return json(rpcError(null, RPC.invalidRequest, "Forbidden: this Origin may not call the MCP endpoint."), 403);

  const auth = await authenticateApiKey(req, "read:status");
  if (!auth.ok) return auth.response;
  const key = auth.key;

  const text = await readBody(req);
  if (text === null) return json(rpcError(null, RPC.invalidRequest, `The body is larger than ${MAX_BODY_BYTES / 1024} KB.`), 413);
  const msg = parseMessage(text);
  if (msg.kind === "error") return json(rpcError(msg.id, msg.code, msg.message), 400);

  const era = eraOf(msg, req.headers);
  if (era.era === "reject") return json(era.error, era.status);

  // Notifications (notifications/initialized, cancelled, …) need no answer and are not recorded.
  if (msg.kind === "notification") return json(null, 202);

  const info = era.era === "modern" ? era.clientInfo
    : msg.method === "initialize" ? (msg.params.clientInfo as { name?: unknown; version?: unknown } | undefined) ?? null
    : rememberedClient(key.keyId);
  const client = mcpClient(key.client, info);
  if (msg.method === "initialize") rememberClient(key.keyId, client);
  const ctxKey = { ...key, client };

  const out = await dispatch(msg, era.era, era.version, ctxKey);
  if (out.record) {
    after(async () => {
      try {
        await recordMcpCall({
          at: new Date(started), keyId: key.keyId, client, providerId: null, model: null, kind: "mcp", tool: out.record!.tool,
          tokensIn: null, tokensOut: null, latencyMs: Date.now() - started, status: out.status, errorClass: out.record!.errorClass, stream: false,
        });
      } catch (e) {
        console.warn("recording an MCP call failed:", e instanceof Error ? e.name : "unknown");
      }
    });
  }
  return json(out.body, out.status);
}

type Outcome = { body: RpcResponse; status: number; record: { tool: string; errorClass: string | null } | null };

async function dispatch(msg: JsonRpcRequest, era: "modern" | "legacy", version: string, key: ApiKeyContext): Promise<Outcome> {
  const done = (result: Record<string, unknown>, tool: string): Outcome => ({ body: rpcResult(msg.id, shapeResult(era, result)), status: 200, record: { tool, errorClass: null } });
  const err = (code: number, message: string, tool: string | null, status = 200): Outcome => ({
    body: rpcError(msg.id, code, message), status, record: tool ? { tool, errorClass: `rpc_${Math.abs(code)}` } : null,
  });

  switch (msg.method) {
    case "initialize":
      return done({ protocolVersion: version, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS }, "initialize");
    case "server/discover":
      return done({
        supportedVersions: SUPPORTED_VERSIONS, capabilities: CAPABILITIES,
        _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO }, instructions: INSTRUCTIONS,
      }, "server/discover");
    case "ping":
      return { body: rpcResult(msg.id, shapeResult(era, {})), status: 200, record: null };
    case "tools/list":
      return done({ tools: toolsFor(key.scopes) }, "tools/list");
    case "tools/call": {
      const tool = findTool(msg.params.name);
      if (!tool) return err(RPC.invalidParams, `Unknown tool: ${String(msg.params.name ?? "").slice(0, 60)}`, "tools/call");
      if (!key.scopes.includes(tool.scope)) return err(RPC.forbidden, `This key needs the ${tool.scope} scope for ${tool.name}.`, tool.name);
      try {
        const result = await tool.call(msg.params.arguments, { key, now: new Date() });
        // The VM poller checks the inbox every few seconds: an empty answer isn't worth a Logs/ai_usage row.
        const emptyInbox = tool.name === "list_pending_questions" && !result.isError
          && Array.isArray((result.structuredContent as { questions?: unknown } | undefined)?.questions)
          && (result.structuredContent as { questions: unknown[] }).questions.length === 0;
        const record = emptyInbox ? null : { tool: tool.name, errorClass: result.isError ? "tool_error" : null };
        return { body: rpcResult(msg.id, shapeResult(era, result)), status: 200, record };
      } catch (e) {
        // Never echo the error: a driver error can carry data. The name is enough for the logs.
        console.error(`MCP tool ${tool.name} failed:`, e instanceof Error ? e.name : "unknown");
        return err(RPC.internalError, "The console could not answer right now. Try again.", tool.name);
      }
    }
    default:
      // 2026-07-28: an unknown method is HTTP 404 + -32601; legacy revisions answer the error with 200.
      return err(RPC.methodNotFound, `Method not found: ${msg.method.slice(0, 60)}`, null, era === "modern" ? 404 : 200);
  }
}

