import "server-only";
import { after } from "next/server";
import { z } from "zod";
import { AI_COPY } from "@/lib/copy/edition";
import { DEMO_AI_REPLY } from "@/lib/demo/simulate";
import { isDemo } from "@/lib/mode";
import { type ApiErrorType, apiError, apiJson } from "@/private/api/respond";
import { authenticateApiKey, type ApiKeyContext } from "@/private/auth/api-key";
import { AG_PUBLIC_PREFIX, enabledModels, isFresh, readAgSettings } from "@/private/ai/extras";
import { ownObservations } from "@/private/ai/quota";
import type { QuotaObservation } from "@/private/ai/types";
import { chat, type ChatBody, classifyUpstreamError, type OpenConnection, readQuota, UpstreamError, upstreamMessage } from "./providers/adapter";
import { PRESETS } from "./providers/presets";
import { consoleDefaultModel, openConnections, resolveModel } from "./providers/providers-db";
import { defaultConnection, isOfferedModel, pickDefaultModel, publicId, routeModel } from "./providers/routing";
import { type CallRecord, CONSOLE_CLIENT, recordCall } from "./usage";

// The OpenAI-compatible gateway (R4). One DB round trip before the upstream call (authenticateApiKey) and one after it
// (recordCall inside after()); provider connections come from a 60 s cache. Prompts and completions are never stored
// or logged (R5): only metadata reaches recordCall.

export const MAX_BODY_BYTES = 256 * 1024;

const num = () => z.number().finite();
const Message = z.looseObject({
  role: z.enum(["system", "developer", "user", "assistant", "tool", "function"]),
  content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
});
// Allow-list (R4): anything else the caller sends is dropped, not forwarded.
const ChatSchema = z.object({
  model: z.string().trim().min(1).max(200),
  messages: z.array(Message).min(1).max(100),
  stream: z.boolean().nullish(),
  stream_options: z.looseObject({}).nullish(),
  temperature: num().min(0).max(2).nullish(),
  top_p: num().min(0).max(1).nullish(),
  max_tokens: z.number().int().min(1).max(1_000_000).nullish(),
  max_completion_tokens: z.number().int().min(1).max(1_000_000).nullish(),
  stop: z.union([z.string().max(200), z.array(z.string().max(200)).max(4)]).nullish(),
  n: z.literal(1).nullish(),
  presence_penalty: num().min(-2).max(2).nullish(),
  frequency_penalty: num().min(-2).max(2).nullish(),
  seed: z.number().int().nullish(),
  response_format: z.looseObject({ type: z.string().max(40) }).nullish(),
  tools: z.array(z.looseObject({})).max(128).nullish(),
  tool_choice: z.union([z.string().max(40), z.looseObject({})]).nullish(),
  user: z.string().max(256).nullish(),
});
export type ChatRequest = z.infer<typeof ChatSchema>;

export function firstIssue(error: z.ZodError): string {
  const i = error.issues[0];
  if (!i) return "Invalid request body.";
  const path = i.path.length ? i.path.join(".") : "body";
  return `${path}: ${i.message}`;
}

type BodyResult = { ok: true; body: ChatRequest } | { ok: false; message: string; status: number };

export async function readChatBody(req: Request): Promise<BodyResult> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return { ok: false, message: "The request body is larger than 256 KB.", status: 413 };
  const text = await req.text().catch(() => null);
  if (text === null) return { ok: false, message: "Can't read the request body.", status: 400 };
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return { ok: false, message: "The request body is larger than 256 KB.", status: 413 };
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { ok: false, message: "The request body isn't valid JSON.", status: 400 }; }
  const parsed = ChatSchema.safeParse(json);
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error), status: 400 };
  return { ok: true, body: parsed.data };
}

// The body sent upstream: the allow-listed fields without nulls, `model` rewritten, usage requested when streaming.
export function upstreamBody(body: ChatRequest, upstream: string, streamUsage: boolean): ChatBody {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (v !== null && v !== undefined) out[k] = v;
  out.model = upstream;
  if (body.stream && streamUsage) out.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
  return out as ChatBody;
}

type Usage = { in: number | null; out: number | null };
const tokenCount = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const usageOf = (u: unknown): Usage | null => {
  if (!u || typeof u !== "object") return null;
  const o = u as Record<string, unknown>;
  return { in: tokenCount(o.prompt_tokens), out: tokenCount(o.completion_tokens) };
};

// Forwards the upstream bytes unchanged; reads SSE `data:` lines only to pick up the final usage chunk.
export function meterStream(upstream: ReadableStream<Uint8Array>): { stream: ReadableStream<Uint8Array>; done: Promise<{ usage: Usage | null; end: "ok" | "aborted" | "error" }> } {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let usage: Usage | null = null;
  let settle: (v: { usage: Usage | null; end: "ok" | "aborted" | "error" }) => void = () => undefined;
  const done = new Promise<{ usage: Usage | null; end: "ok" | "aborted" | "error" }>((r) => { settle = r; });
  let settled = false;
  const finish = (end: "ok" | "aborted" | "error") => { if (!settled) { settled = true; settle({ usage, end }); } };
  const scan = (text: string) => {
    buf += text;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data.includes("\"usage\"")) continue;
      try {
        const u = usageOf((JSON.parse(data) as { usage?: unknown }).usage);
        if (u) usage = u;
      } catch { /* not JSON: forwarded anyway */ }
    }
    if (buf.length > 1_000_000) buf = buf.slice(-64_000); // a line without newline can't grow without bound
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const r = await reader.read();
        if (r.done) {
          scan(`${decoder.decode()}\n`);
          finish("ok");
          ctrl.close();
          return;
        }
        scan(decoder.decode(r.value, { stream: true }));
        ctrl.enqueue(r.value);
      } catch (e) {
        finish("error");
        ctrl.error(e);
      }
    },
    async cancel(reason) {
      finish("aborted");
      await reader.cancel(reason).catch(() => undefined);
    },
  }, { highWaterMark: 0 });
  return { stream, done };
}

function safeRecord(rec: CallRecord, quota: QuotaObservation[] = []): Promise<void> {
  return recordCall(rec, quota).catch((e) => { console.error("ai usage not recorded:", e instanceof Error ? e.name : "unknown"); });
}

// after() outside a request scope (a script, a test without Next) throws; the write then runs right away.
function later(fn: () => Promise<void>): void {
  try { after(fn); } catch { void fn(); }
}

function quotaFor(conn: OpenConnection, model: string, usage: Usage | null, headers: Headers | null, now: Date): QuotaObservation[] {
  const tokens = usage && (usage.in !== null || usage.out !== null) ? (usage.in ?? 0) + (usage.out ?? 0) : null;
  return [...(headers ? readQuota(conn, model, headers, now) : []), ...ownObservations(conn.id, conn.limits, model, tokens, now)];
}

export async function handleChat(req: Request): Promise<Response> {
  const started = Date.now();
  const auth = await authenticateApiKey(req, "ai:invoke");
  if (!auth.ok) return auth.response;
  const key: ApiKeyContext = auth.key;
  const at = new Date(started);
  const base: Omit<CallRecord, "latencyMs" | "status"> = {
    at, keyId: key.keyId, client: key.client, providerId: null, model: null, kind: "chat", tool: null,
    tokensIn: null, tokensOut: null, errorClass: null, stream: false,
  };
  const record = (r: Partial<CallRecord> & { status: number }, quota: QuotaObservation[] = []) =>
    later(() => safeRecord({ ...base, latencyMs: Date.now() - started, ...r }, quota));
  const fail = (type: ApiErrorType, message: string, status: number, extra: Partial<CallRecord> = {}, headers?: HeadersInit) => {
    record({ status, errorClass: type, ...extra });
    return apiError(type, message, status, headers);
  };

  const read = await readChatBody(req);
  if (!read.ok) return fail("invalid_request", read.message, read.status);
  const body = read.body;
  const stream = body.stream === true;

  const target = await resolveModel(body.model, { providerId: key.providerId, model: key.model });
  if (target === "provider_not_connected") return fail("provider_not_connected", "No AI provider is connected or enabled for this model. Connect one under AI Gateway › Bring your own key.", 503, { stream });
  if (target === "model_not_enabled") return fail("model_not_enabled", `Model "${body.model.slice(0, 120)}" isn't enabled. GET /api/v1/ai/models lists the models this key can use.`, 400, { stream });
  const { conn, upstream } = target;
  const meta = { providerId: conn.id, model: target.publicId, stream };

  let res: Response;
  try {
    res = await chat(conn, upstreamBody(body, upstream, PRESETS[conn.kind].streamUsage), req.signal);
  } catch (e) {
    if (e instanceof UpstreamError) return fail(e.info.type, e.message, e.info.status, { ...meta, errorClass: `${e.info.type} · ${e.info.errorClass}` });
    record({ ...meta, status: 499, errorClass: "client_closed" });
    return new Response(null, { status: 499 });
  }
  const now = new Date();
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const info = classifyUpstreamError(res.status, text);
    const header = Number(res.headers.get("retry-after"));
    const retryAfter = info.retryAfter ?? (Number.isFinite(header) && header > 0 ? Math.ceil(header) : null);
    record({ ...meta, status: info.status, errorClass: `${info.type} · ${info.errorClass}` }, readQuota(conn, upstream, res.headers, now));
    return apiError(info.type, upstreamMessage(info.errorClass, res.status, conn.name), info.status, retryAfter ? { "Retry-After": String(retryAfter) } : undefined);
  }

  if (stream && res.body) {
    const metered = meterStream(res.body);
    const headers = new Headers(res.headers);
    later(async () => {
      const r = await metered.done;
      const status = r.end === "ok" ? 200 : r.end === "aborted" ? 499 : 502;
      await safeRecord({
        ...base, ...meta, latencyMs: Date.now() - started, status, errorClass: r.end === "ok" ? null : r.end === "aborted" ? "client_closed" : "upstream_error · stream_broken",
        tokensIn: r.end === "aborted" ? null : r.usage?.in ?? null, tokensOut: r.end === "aborted" ? null : r.usage?.out ?? null,
      }, quotaFor(conn, upstream, r.end === "aborted" ? null : r.usage, headers, new Date()));
    });
    return new Response(metered.stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
    });
  }

  let json: Record<string, unknown>;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    return fail("upstream_error", upstreamMessage("bad_response", res.status, conn.name), 502, { ...meta, errorClass: "upstream_error · bad_response" });
  }
  const usage = usageOf(json.usage);
  record({ ...meta, status: 200, tokensIn: usage?.in ?? null, tokensOut: usage?.out ?? null }, quotaFor(conn, upstream, usage, res.headers, now));
  return apiJson({ ...json, model: target.publicId }, { status: 200 });
}

// ---- The console's own AI (Ask AI, summary, Playground, console chat). No key; agent row "Watchbell console". ----

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
// timeoutMs: the upstream call's own limit (default UPSTREAM_TIMEOUT_MS, 60 s); Patroli gives each room less.
export type CompleteOptions = {
  model?: string; maxTokens?: number; temperature?: number; timeoutMs?: number;
  purpose: "ask-ai" | "summary" | "playground" | "console-chat" | "office-patrol" | "office-dev";
};
export type CompleteResult = { text: string; model: string; usage: { in: number | null; out: number | null }; ms: number };

export class GatewayError extends Error {
  constructor(public readonly type: ApiErrorType, message: string, public readonly status: number) {
    super(message);
    this.name = "GatewayError";
  }
}

// The model the console uses when none is asked for: gemini-3.8-flash on the default connection if it's on, else the
// newest Gemma instruct model on Workers AI, else the first enabled one.
export async function consoleTarget(model?: string): Promise<{ conn: OpenConnection; upstream: string; publicId: string }> {
  if (model) {
    const t = await resolveModel(model, null);
    if (t === "provider_not_connected") throw new GatewayError(t, "No AI provider is connected. Connect one under AI Gateway › Bring your own key.", 503);
    if (t === "model_not_enabled") throw new GatewayError(t, `Model "${model.slice(0, 120)}" isn't enabled.`, 400);
    return t;
  }
  const [conns, preferred] = await Promise.all([openConnections(), consoleDefaultModel()]);
  // The owner's "Make default" (ai.defaultModel) wins when that model is still allowed, turned on, and its provider is
  // connected and enabled (routeModel checks all of that); otherwise the default connection's own pick.
  if (preferred) {
    const r = routeModel(conns, preferred, null);
    if (typeof r !== "string") return { conn: r.conn as OpenConnection, upstream: r.model.upstream, publicId: r.publicId };
  }
  const conn = defaultConnection(conns);
  if (!conn) throw new GatewayError("provider_not_connected", "No AI provider is connected. Connect one under AI Gateway › Bring your own key.", 503);
  const m = pickDefaultModel(conn.models.filter((x) => x.enabled && isOfferedModel(x, conn.kind)));
  if (!m) throw new GatewayError("model_not_enabled", `No model is turned on for ${conn.name}. Turn one on under Models.`, 400);
  return { conn, upstream: m.upstream, publicId: publicId(conn, m) };
}

async function completeOn(t: { conn: OpenConnection; upstream: string; publicId: string }, messages: ChatMessage[], opts: CompleteOptions): Promise<CompleteResult> {
  const started = Date.now();
  const { conn, upstream, publicId: model } = t;
  const client = { ...CONSOLE_CLIENT, userAgent: `Watchbell console (${opts.purpose})` };
  const base = { at: new Date(started), keyId: null, client, providerId: conn.id, model, kind: "console" as const, tool: null, stream: false };
  const body: ChatBody = { model: upstream, messages, max_tokens: Math.min(Math.max(opts.maxTokens ?? 1024, 1), 8192), ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}) };
  let res: Response;
  try {
    res = opts.timeoutMs ? await chat(conn, body, new AbortController().signal, opts.timeoutMs) : await chat(conn, body, new AbortController().signal);
  } catch (e) {
    const info = e instanceof UpstreamError ? e.info : { type: "upstream_error" as const, errorClass: "network", status: 502 };
    later(() => safeRecord({ ...base, latencyMs: Date.now() - started, status: info.status, errorClass: `${info.type} · ${info.errorClass}`, tokensIn: null, tokensOut: null }));
    throw new GatewayError(info.type, e instanceof UpstreamError ? e.message : upstreamMessage("network", 0, conn.name), info.status);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const info = classifyUpstreamError(res.status, text);
    later(() => safeRecord({ ...base, latencyMs: Date.now() - started, status: info.status, errorClass: `${info.type} · ${info.errorClass}`, tokensIn: null, tokensOut: null }, readQuota(conn, upstream, res.headers, new Date())));
    throw new GatewayError(info.type, upstreamMessage(info.errorClass, res.status, conn.name), info.status);
  }
  const json = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[]; usage?: unknown } | null;
  const content = json?.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("") : "";
  const usage = usageOf(json?.usage) ?? { in: null, out: null };
  const ms = Date.now() - started;
  const ok = json !== null;
  later(() => safeRecord({ ...base, latencyMs: ms, status: ok ? 200 : 502, errorClass: ok ? null : "upstream_error · bad_response", tokensIn: usage.in, tokensOut: usage.out }, quotaFor(conn, upstream, usage, res.headers, new Date())));
  if (!ok) throw new GatewayError("upstream_error", upstreamMessage("bad_response", res.status, conn.name), 502);
  return { text, model, usage, ms };
}

// Fallback (owner 16 Oct, "mode tahan banting"; the VM running 9Router goes away by ~31 Dec): when the provider a console
// call went to is down (network error, 5xx, rate limit), the call is tried ONCE on another enabled provider with a
// turned-on model. A pinned model (opts.model) never falls back, nor do 4xx answers about the request itself.
export const FALLBACK_STATUSES = new Set([429, 500, 502, 503, 504]);
export const fallsBack = (e: unknown): boolean => e instanceof GatewayError && FALLBACK_STATUSES.has(e.status);

export async function fallbackTarget(exceptId: string): Promise<{ conn: OpenConnection; upstream: string; publicId: string } | null> {
  const conns = (await openConnections()).filter((c) => c.enabled && c.id !== exceptId);
  for (const conn of conns) {
    const m = pickDefaultModel(conn.models.filter((x) => x.enabled && isOfferedModel(x, conn.kind)));
    if (m) return { conn: conn as OpenConnection, upstream: m.upstream, publicId: publicId(conn as OpenConnection, m) };
  }
  return null;
}

export async function complete(messages: ChatMessage[], opts: CompleteOptions): Promise<CompleteResult> {
  if (isDemo()) return { text: DEMO_AI_REPLY, model: "demo", usage: { in: null, out: null }, ms: 0 }; // never a provider call
  const first = await consoleTarget(opts.model);
  try {
    return await completeOn(first, messages, opts);
  } catch (e) {
    if (opts.model || !fallsBack(e)) throw e;
    const other = await fallbackTarget(first.conn.id).catch(() => null);
    if (!other) throw e;
    console.info(`ai: ${first.conn.name} failed, trying ${other.conn.name}`);
    return completeOn(other, messages, opts);
  }
}

// GET /api/v1/ai/models (scope ai:invoke): the OpenAI list of the models this key can use, ids "provider/model".
export async function handleModels(req: Request): Promise<Response> {
  const started = Date.now();
  const auth = await authenticateApiKey(req, "ai:invoke");
  if (!auth.ok) return auth.response;
  const key = auth.key;
  const conns = (await openConnections()).filter((c) => c.enabled);
  let list: { id: string; providerId: string }[];
  if (key.model) {
    const r = routeModel(conns, key.model, { providerId: key.providerId, model: null });
    list = typeof r === "string" ? [] : [{ id: r.publicId, providerId: r.conn.id }];
  } else {
    list = conns
      .filter((c) => !key.providerId || c.id === key.providerId)
      .flatMap((c) => c.models.filter((m) => m.enabled && isOfferedModel(m, c.kind)).map((m) => ({ id: publicId(c, m), providerId: c.id })));
  }
  // Antigravity's models (owner 13 Oct): "ag/<id>" ("ag" can't be a connection's name), owned_by "antigravity",
  // async: true = ask them with POST /api/v1/ai/questions {"model"}, not /chat/completions. A pinned key sees only its pin.
  let agIds: string[] = [];
  if (!key.model && !key.providerId) {
    try {
      const now = new Date();
      const { report, prefs, allowed } = await readAgSettings(now);
      // Owner 14 Oct: listed only while Antigravity is connected (a fresh report; readAgSettings drops a revoked key's).
      agIds = isFresh(report, now) ? enabledModels(report, prefs, allowed) : [];
    } catch {
      console.warn(AI_COPY.modelsReadFailed);
    }
  }
  later(() => safeRecord({
    at: new Date(started), keyId: key.keyId, client: key.client, providerId: null, model: null, kind: "models", tool: null,
    tokensIn: null, tokensOut: null, latencyMs: Date.now() - started, status: 200, errorClass: null, stream: false,
  }));
  return apiJson({ object: "list", data: [
    ...list.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "watchbell" })),
    ...agIds.map((id) => ({ id: `${AG_PUBLIC_PREFIX}${id}`, object: "model", created: 0, owned_by: "antigravity", async: true })),
  ] });
}
