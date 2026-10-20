import { OPENAPI_COPY } from "@/lib/copy/edition";
import type { Scope } from "@/private/auth/api-key";

// The ONE hand-written description of every endpoint (R9, R10). The OpenAPI 3.1 document (spec.ts) and the API explorer
// page are both built from it, so they can't disagree. Pure: the explorer's client component imports it too.
// The mockup's API_OPS (mockup/index.html) is the source of the texts and examples.

export type OpTag = "AI" | "Console" | "MCP" | "Health" | "Heartbeats" | "Scheduler";
export type ParamIn = "path" | "query" | "header";
export type ParamSpec = {
  name: string; in: ParamIn; type: "string" | "integer"; required: boolean; description: string;
  example?: string;
  // The value the builder starts with (an empty value is left out of the request).
  default?: string;
  // Never stored with a saved example and written as an environment variable in the snippets (a heartbeat token).
  secret?: boolean;
};
export type OpExample = { name: string; query?: Record<string, string>; path?: Record<string, string>; headers?: Record<string, string>; body?: string };

// key: needs a console API key (Authorization: Bearer wb_…). keyOrOwner: a key, or the owner's session (read-only
// openapi.json). none: public. token: the secret is in the path (heartbeat ping). secret: a scheduler's own secret or signature.
export type OpAccess = "key" | "keyOrOwner" | "none" | "token" | "secret";

export type ApiOp = {
  id: string; operationId: string; tag: OpTag; method: "get" | "post" | "head"; path: string;
  access: OpAccess;
  // The console API key scope; null when the endpoint doesn't use a console key.
  scope: Scope | "any" | null;
  // What the endpoint's chip shows: "ai:invoke", "any key", "scheduler secret" …
  scopeLabel: string;
  summary: string; description: string;
  docsOnly: boolean;
  // The environment variable a snippet reads a bearer secret from, when the endpoint takes one that is not a console key.
  bearerEnv?: string;
  params: ParamSpec[];
  body?: string; bodyDescription?: string;
  response?: { status: number; contentType: string; example: string; description: string };
  // Further success answers of the same operation (POST /api/v1/ai/questions: 201 answered now, 202 queued).
  alsoResponses?: { status: number; contentType: string; example: string; description: string }[];
  examples?: OpExample[];
};

const xClient: ParamSpec = {
  name: "X-Client", in: "header", type: "string", required: false, default: "api-explorer", example: "my-agent/1.0",
  description: "Names the caller as an agent (name/version) when the request doesn't say it otherwise. The API explorer sends api-explorer.",
};

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

const CHAT_BODY = pretty({ model: "gemini/gemini-3.8-flash", messages: [{ role: "user", content: "Say hello in five words." }], stream: false });
const STATUS_RESPONSE = pretty({
  generatedAt: "2026-10-13T00:41:12.000Z",
  apps: [
    { id: "orbit-blog", state: "down", uptime30d: 98.71, database: null, lastDeploy: "abc1234 · failed 19:41",
      problems: [{ kind: "monitor", where: "Monitor /", what: "HTTP 502", fix: "Open Logs (last hour) for errors; Check the latest deployment; roll back if it started after the deploy" }] },
    { id: "acme-shop", state: "degraded", uptime30d: 99.9, database: "db-b", lastDeploy: "9f3c2a1 · 3 days ago",
      problems: [{ kind: "database", where: "Database db-b", what: "Paused", fix: "Restore the database from its provider (Supabase restore)" }] },
  ],
  monitors: { up: 6, degraded: 1, down: 1, paused: 0, items: [{ app: "orbit-blog", path: "/", kind: "http", state: "down", lastStatus: 502, latencyMs: 311, uptime30d: 98.71, lastCheckedAt: "2026-10-13T00:41:00.000Z" }] },
  alerts: { open: 5, critical: 1, items: [{ title: "orbit-blog is down", severity: "critical", app: "orbit-blog", since: "2026-10-13T00:37:00.000Z", message: "HTTP 502 on /." }] },
  advisor: [{ title: "Next.js 15 reaches end of life on 21 Oct 2026", app: "acme-shop", severity: "warning" }],
});
const STATUS_APP_RESPONSE = pretty({
  id: "orbit-blog", state: "down", uptime30d: 98.71, database: null, lastDeploy: "abc1234 · failed 19:41",
  problems: [{ kind: "monitor", where: "Monitor /", what: "HTTP 502", fix: "Open Logs (last hour) for errors; Check the latest deployment; roll back if it started after the deploy" }],
  monitors: [{ path: "/", kind: "http", state: "down", lastStatus: 502, latencyMs: 311, uptime30d: 98.71 }],
});
const ADVICE_RESPONSE = pretty({
  app: "orbit-blog",
  notes: [{
    id: "5b0f8e0c-2f0a-4b53-9d54-6c1f0d6f6a11", severity: "warn", title: "Deploy failed twice today",
    body: "The last two production deploys failed at the build step. Roll back to the previous deployment, then fix the build and redeploy.",
    source: OPENAPI_COPY.noteSource, model: "gemini-3.8-flash", createdAt: "2026-10-13T01:02:03.000Z",
  }],
});

export const OPS: ApiOp[] = [
  {
    id: "ai-chat", operationId: "createChatCompletion", tag: "AI", method: "post", path: "/api/v1/ai/chat/completions", access: "key", scope: "ai:invoke", scopeLabel: "ai:invoke",
    summary: "Chat completion (OpenAI-compatible)",
    description: "Forwards to the provider that owns the model (provider/model, or the default provider for a bare id), over its OpenAI-compatible endpoint. stream: true answers text/event-stream. Fields outside the OpenAI chat schema are rejected.",
    docsOnly: false, params: [xClient], body: CHAT_BODY, bodyDescription: "An OpenAI chat completion request.",
    response: {
      status: 200, contentType: "application/json", description: "The provider's answer, with the model id as Watchbell names it.",
      example: pretty({
        id: "chatcmpl-wp-01JA8", object: "chat.completion", created: 1792021272, model: "gemini/gemini-3.8-flash",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Hello there, nice to meet!" } }],
        usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 },
      }),
    },
    examples: [
      { name: "Hello in five words", body: CHAT_BODY },
      { name: "Streaming (SSE)", body: pretty({ model: "gemini/gemini-3.8-flash", messages: [{ role: "user", content: "Count to five." }], stream: true }) },
      {
        name: OPENAPI_COPY.advisorExample.name,
        body: pretty({
          model: "gemini/gemini-3.8-flash",
          messages: [
            { role: "system", content: OPENAPI_COPY.advisorExample.system },
            { role: "user", content: OPENAPI_COPY.advisorExample.user },
          ],
          max_tokens: 400,
        }),
      },
    ],
  },
  {
    id: "ai-models", operationId: "listModels", tag: "AI", method: "get", path: "/api/v1/ai/models", access: "key", scope: "ai:invoke", scopeLabel: "ai:invoke",
    summary: "List enabled models", description: `The models turned on under AI Gateway › Models, in OpenAI's list format. Provider models are provider/model, owned_by watchbell, and work with /api/v1/ai/chat/completions. ${OPENAPI_COPY.modelsAgSentence}A key pinned to a provider or model sees only that.`,
    docsOnly: false, params: [xClient],
    response: {
      status: 200, contentType: "application/json", description: "An OpenAI-style model list.",
      example: pretty({ object: "list", data: [
        { id: "gemini/gemini-3.8-flash", object: "model", created: 0, owned_by: "watchbell" },
        ...OPENAPI_COPY.agModelExamples,
      ] }),
    },
  },
  {
    id: "ai-questions", operationId: "askQuestion", tag: "AI", method: "post", path: "/api/v1/ai/questions", access: "key", scope: "ai:invoke", scopeLabel: "ai:invoke",
    summary: "Ask a question about the console",
    description: `Asks a question about the console, answered from scrubbed console data (names aliased, no URLs, emails or keys). 1-2000 characters; text that looks like a key or token is refused with 400. Optional model from GET /api/v1/ai/models. Left out, or a provider model id (provider/model, e.g. test/prrojects): the owner's own provider answers in this request (a router combo can take ~25 s) and you get 201 with the answer; the question and answer are kept 7 days (GET pollUrl reads them back, the owner sees them under AI › Ask). A provider error answers with the gateway's message (400 model_not_enabled, 429, 502 upstream_error, 503 provider_not_connected) and nothing is stored.${OPENAPI_COPY.askAgSentence}`,
    docsOnly: false, params: [xClient], body: pretty({ question: "Is anything about to run out this week?" }), bodyDescription: "question: 1-2000 characters, plain text or markdown. model (optional): a provider model id or an ag/<id> from GET /api/v1/ai/models; left out = the default provider's default model.",
    response: {
      status: 201, contentType: "application/json", description: "Answered now by the owner's provider. pollUrl reads the stored question back.",
      example: pretty({
        id: "8c1f2e0a-5b7d-4f3e-9a21-6d4c0b9e7f12", status: "answered", answer: "Nothing runs out this week. db-a is at 81% of its storage; plan a cleanup within a month.",
        answeredBy: { client: "watchpost", model: "test/prrojects" }, askedAt: "2026-10-14T00:40:00.000Z", answeredAt: "2026-10-14T00:40:24.000Z",
        pollUrl: "https://ops.example.com/api/v1/ai/questions/8c1f2e0a-5b7d-4f3e-9a21-6d4c0b9e7f12",
      }),
    },
    alsoResponses: [{
      status: 202, contentType: "application/json", description: OPENAPI_COPY.queued,
      example: pretty({ id: "8c1f2e0a-5b7d-4f3e-9a21-6d4c0b9e7f12", status: "pending", askedAt: "2026-10-13T07:40:00.000Z", requestedModel: "ag/gemini-3.8-flash-high", pollUrl: "https://ops.example.com/api/v1/ai/questions/8c1f2e0a-5b7d-4f3e-9a21-6d4c0b9e7f12" }),
    }],
  },
  {
    id: "ai-question", operationId: "getQuestion", tag: "AI", method: "get", path: "/api/v1/ai/questions/{id}", access: "key", scope: "ai:invoke", scopeLabel: "ai:invoke",
    summary: "A question and its answer",
    description: `One question this key asked with POST /api/v1/ai/questions, for 7 days. status is pending, answered or expired (no answer within 7 days). answer is the markdown answer (up to 8000 characters) from the owner's provider (answeredBy.client watchbell) or ${OPENAPI_COPY.answeredByAgent}. Another key's or the owner's questions answer 404 like an unknown id. requestedModel is the ag/<id> asked for, or null (default).`,
    docsOnly: false,
    params: [{ name: "id", in: "path", type: "string", required: true, example: "8c1f2e0a-5b7d-4f3e-9a21-6d4c0b9e7f12", description: "The id from POST /api/v1/ai/questions." }, xClient],
    response: {
      status: 200, contentType: "application/json", description: "The question; answer and answeredBy are null until it is answered.",
      example: pretty({
        id: "8c1f2e0a-5b7d-4f3e-9a21-6d4c0b9e7f12", status: "answered", question: "Is anything about to run out this week?", requestedModel: "ag/gemini-3.8-flash-high",
        answer: "Two things: the **db-b** Supabase project pauses on Friday without traffic, and the certificate of app-a renews automatically.",
        answeredBy: { client: OPENAPI_COPY.answeredByClient, model: "gemini-3.8-flash-high" }, askedAt: "2026-10-13T07:40:00.000Z", answeredAt: "2026-10-13T07:41:12.000Z",
      }),
    },
  },
  {
    id: "status", operationId: "getStatus", tag: "Console", method: "get", path: "/api/v1/status", access: "key", scope: "read:status", scopeLabel: "read:status",
    summary: "Console summary",
    description: "Apps, monitors, open alerts and the advisor, scrubbed: database aliases, no URLs, emails or secrets.",
    docsOnly: false,
    params: [
      { name: "include", in: "query", type: "string", required: false, example: "apps,alerts", description: "Comma-separated sections to return: apps, monitors, alerts, advisor. Default: all four." },
      xClient,
    ],
    response: { status: 200, contentType: "application/json", description: "The requested sections of the console snapshot.", example: STATUS_RESPONSE },
    examples: [{ name: "Everything" }, { name: "Only alerts", query: { include: "alerts" } }],
  },
  {
    id: "status-app", operationId: "getAppStatus", tag: "Console", method: "get", path: "/api/v1/status/apps/{app}", access: "key", scope: "read:status", scopeLabel: "read:status",
    summary: "One app with its Why problems", description: "Same shape as one entry of apps[], plus its monitors and the remedies. The app is its name or console id; 404 not_found when it isn't a watched app.",
    docsOnly: false,
    params: [{ name: "app", in: "path", type: "string", required: true, example: "orbit-blog", description: "The app's name (as in apps[].id) or console id." }, xClient],
    response: { status: 200, contentType: "application/json", description: "One app.", example: STATUS_APP_RESPONSE },
  },
  {
    id: "advice", operationId: "getAppAdvice", tag: "Console", method: "get", path: "/api/v1/advice", access: "key", scope: "read:status", scopeLabel: "read:status",
    summary: "Latest AI notes for one app",
    description: `The newest AI notes (up to 5, not dismissed) that ${OPENAPI_COPY.adviceAgent} wrote about the app, scrubbed like /status. ${OPENAPI_COPY.adviceFor} for the app by name or id; 404 not_found when it isn't a watched app.`,
    docsOnly: false,
    params: [{ name: "app", in: "query", type: "string", required: true, example: "orbit-blog", description: "The app's name or console id." }, xClient],
    response: { status: 200, contentType: "application/json", description: "The app and its latest notes, newest first (an empty list when there are none).", example: ADVICE_RESPONSE },
  },
  {
    id: "me", operationId: "getMe", tag: "Console", method: "get", path: "/api/v1/me", access: "key", scope: "any", scopeLabel: "any key",
    summary: "The calling key", description: "Name, prefix, scopes, rate limit and expiry of the key you send. Handy to test a key.",
    docsOnly: false, params: [xClient],
    response: {
      status: 200, contentType: "application/json", description: "The key's public details (never the key or its hash).",
      example: pretty({ name: "laptop-agents", prefix: "wb_Lm9x", scopes: ["ai:invoke", "read:status"], rateLimitPerMin: 30, expiresAt: null }),
    },
  },
  {
    id: "openapi", operationId: "getOpenApi", tag: "Console", method: "get", path: "/api/v1/openapi.json", access: "keyOrOwner", scope: "any", scopeLabel: "any key or owner session",
    summary: "This OpenAPI 3.1 document", description: "The description every endpoint of this page is built from. Needs any valid key, or the owner's signed-in session (so the download button works).",
    docsOnly: false, params: [xClient],
    response: { status: 200, contentType: "application/json", description: "An OpenAPI 3.1 document.", example: pretty({ openapi: "3.1.0", info: { title: "Watchbell API", version: "1.0.0" }, paths: { "/api/v1/status": { get: { operationId: "getStatus" } } } }) },
  },
  {
    id: "mcp", operationId: "mcpRpc", tag: "MCP", method: "post", path: "/api/v1/mcp", access: "key", scope: "read:status", scopeLabel: "read:status",
    summary: "MCP server (Streamable HTTP)",
    description: `JSON-RPC 2.0 for Model Context Protocol clients (${OPENAPI_COPY.mcpClients}). initialize, tools/list and tools/call for the read-only tools; submit_ai_note needs write:notes. Answers JSON (no server-sent stream needed); GET and DELETE answer 405.`,
    docsOnly: false,
    params: [
      { name: "Accept", in: "header", type: "string", required: true, default: "application/json, text/event-stream", description: "Both types, as the MCP transport requires." },
      { name: "MCP-Protocol-Version", in: "header", type: "string", required: false, default: "2025-06-18", description: "The protocol revision the client speaks." },
      xClient,
    ],
    body: pretty({ jsonrpc: "2.0", id: 1, method: "tools/list" }), bodyDescription: "One JSON-RPC 2.0 message (batches are rejected).",
    response: {
      status: 200, contentType: "application/json", description: "The JSON-RPC response.",
      example: pretty({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "list_apps", description: "Every app with its state …" }, { name: "get_app", description: "One app with its Why problems …" }] } }),
    },
    examples: [
      { name: "tools/list", body: pretty({ jsonrpc: "2.0", id: 1, method: "tools/list" }) },
      { name: "tools/call get_app", body: pretty({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_app", arguments: { app: "orbit-blog" } } }) },
      {
        name: "initialize",
        body: pretty({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "api-explorer", version: "1.0" } } }),
      },
    ],
  },
  {
    id: "health", operationId: "getHealth", tag: "Health", method: "get", path: "/api/health", access: "none", scope: null, scopeLabel: "no key",
    summary: "Liveness check", description: "Answers 200 while the console is up. Public, no database read; point an uptime checker at it.",
    docsOnly: false, params: [],
    response: { status: 200, contentType: "application/json", description: "Always ok while the console answers.", example: pretty({ ok: true, service: "watchbell" }) },
  },
  {
    id: "ping", operationId: "pingHeartbeat", tag: "Heartbeats", method: "post", path: "/api/ping/{token}", access: "token", scope: null, scopeLabel: "heartbeat token",
    summary: "Heartbeat ping (GET and HEAD work too)",
    description: "A job tells Watchbell it ran. The token is shown once when the heartbeat monitor is created; Watchbell keeps only its hash, so this page can't fill it in. Paste it below to try a ping: it is used for this request only and never stored. A real ping changes the monitor's state.",
    docsOnly: false,
    params: [{ name: "token", in: "path", type: "string", required: true, secret: true, example: "hb_0123456789abcdef0123456789abcdef", description: "The heartbeat token (hb_ and 32 hex characters)." }],
    response: { status: 200, contentType: "text/plain", description: "OK; 404 for an unknown token, 429 when pinged too often.", example: "OK" },
  },
  {
    id: "ping-start", operationId: "pingHeartbeatStart", tag: "Heartbeats", method: "post", path: "/api/ping/{token}/start", access: "token", scope: null, scopeLabel: "heartbeat token",
    summary: "Heartbeat: the job started", description: "Marks the start of a run. If no OK ping follows within the grace time the monitor is down. Same token rules as /api/ping/{token}.",
    docsOnly: false,
    params: [{ name: "token", in: "path", type: "string", required: true, secret: true, example: "hb_0123456789abcdef0123456789abcdef", description: "The heartbeat token." }],
    response: { status: 200, contentType: "text/plain", description: "OK.", example: "OK" },
  },
  {
    id: "ping-fail", operationId: "pingHeartbeatFail", tag: "Heartbeats", method: "post", path: "/api/ping/{token}/fail", access: "token", scope: null, scopeLabel: "heartbeat token",
    summary: "Heartbeat: the job failed", description: "Reports a failure; the monitor goes down at once. Same token rules as /api/ping/{token}.",
    docsOnly: false,
    params: [{ name: "token", in: "path", type: "string", required: true, secret: true, example: "hb_0123456789abcdef0123456789abcdef", description: "The heartbeat token." }],
    response: { status: 200, contentType: "text/plain", description: "OK.", example: "OK" },
  },
  {
    id: "collect", operationId: "runCollector", tag: "Scheduler", method: "post", path: "/api/collect", access: "secret", scope: null, scopeLabel: "scheduler secret",
    summary: "Collector run", description: "Called every minute by cron-job.org with Authorization: Bearer <COLLECTOR_SECRET>. Docs only: Try it would need the secret.",
    docsOnly: true, bearerEnv: "COLLECTOR_SECRET", params: [],
    response: { status: 200, contentType: "application/json", description: "The run's summary.", example: pretty({ ok: true, ran: ["monitors", "deployments"], errors: [] }) },
  },
  {
    id: "watchdog", operationId: "runWatchdog", tag: "Scheduler", method: "post", path: "/api/watchdog", access: "secret", scope: null, scopeLabel: "QStash signature",
    summary: "Watchdog", description: "Called by Upstash QStash every 5 minutes with an Upstash-Signature header. Docs only.",
    docsOnly: true, params: [],
    response: { status: 200, contentType: "application/json", description: "Whether the collector looked stale.", example: pretty({ stale: false }) },
  },
  {
    id: "daily", operationId: "runDaily", tag: "Scheduler", method: "get", path: "/api/daily", access: "secret", scope: null, scopeLabel: "cron secret",
    summary: "Daily job", description: "Vercel Cron at 03:00 WIB with Authorization: Bearer <CRON_SECRET>. Docs only.",
    docsOnly: true, bearerEnv: "CRON_SECRET", params: [],
    response: { status: 200, contentType: "application/json", description: "The job's summary.", example: pretty({ ok: true, errors: [] }) },
  },
];

export const TAGS: OpTag[] = ["AI", "Console", "MCP", "Health", "Heartbeats", "Scheduler"];
export const TAG_DESCRIPTION: Record<OpTag, string> = {
  AI: "OpenAI-compatible calls through the providers you connected.",
  Console: "Read-only console data for agents and apps.",
  MCP: "Model Context Protocol server.",
  Health: "Liveness.",
  Heartbeats: "Pings from your own jobs.",
  Scheduler: "Called by the schedulers, not by you.",
};

export const opById = (id: string | undefined): ApiOp | undefined => (id ? OPS.find((o) => o.id === id) : undefined);
export const needsKey = (op: ApiOp): boolean => op.access === "key" || op.access === "keyOrOwner";
// Try it is offered for every endpoint a person may call with what the page can hold (a key or a pasted token).
export const canTry = (op: ApiOp): boolean => !op.docsOnly;

// The environment variable a snippet reads the bearer secret from (null: the endpoint takes no bearer).
export const bearerEnvOf = (op: ApiOp): string | null => op.bearerEnv ?? (needsKey(op) ? "WATCHBELL_API_KEY" : null);
