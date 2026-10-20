import "server-only";
import type { ApiErrorType } from "@/private/api/respond";
import type { QuotaObservation } from "@/private/ai/types";
import type { OwnLimit } from "@/private/ai/quota";
import { authHeaders, CLOUDFLARE_API, GEMINI_NATIVE_BASE, type PresetKind, PRESETS, type ProviderSecret } from "./presets";
import { isGatewayModel, publicModelName, type RoutableConnection } from "./routing";

// Talks to one provider connection. Only Watchbell's own headers go upstream (R4): content type, accept and the
// provider's auth header. Upstream error bodies are read only to classify them and are never returned or logged (R3).

export type OpenConnection = RoutableConnection & {
  kind: PresetKind; name: string; baseUrl: string; secret: ProviderSecret; limits: OwnLimit[]; updatedAt: Date;
};
export type ChatBody = Record<string, unknown> & { model: string; stream?: boolean };
export type UpstreamModel = { id: string; upstream: string; ctx?: number; out?: number };

export const UPSTREAM_TIMEOUT_MS = 60_000;

export type UpstreamClass = { type: ApiErrorType; errorClass: string; retryAfter: number | null; status: number };

export class UpstreamError extends Error {
  constructor(public readonly info: UpstreamClass, message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

function retryDelaySeconds(bodyText: string): number | null {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(bodyText);
  return m ? Math.max(1, Math.ceil(Number(m[1]))) : null;
}

// Status to answer the caller with: the caller's own key was fine, so a provider auth failure is a 502, not a 401.
export function classifyUpstreamError(status: number, bodyText: string): UpstreamClass {
  const body = bodyText.slice(0, 20_000);
  if (status === 429) return { type: "quota_exceeded", errorClass: "rate_limited", retryAfter: retryDelaySeconds(body), status: 429 };
  if (status === 403 && /denied access/i.test(body)) return { type: "upstream_error", errorClass: "project_denied", retryAfter: null, status: 502 };
  if (status === 403 && /restricted|billing/i.test(body)) return { type: "upstream_error", errorClass: "project_restricted", retryAfter: null, status: 502 };
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid|API_KEY_SERVICE_BLOCKED|ACCESS_TOKEN_TYPE_UNSUPPORTED/.test(body)) {
    return { type: "upstream_error", errorClass: "auth_rejected", retryAfter: null, status: 502 };
  }
  if (status === 404) return { type: "invalid_request", errorClass: "model_not_found", retryAfter: null, status: 404 };
  if (status === 400 || status === 413 || status === 422) return { type: "invalid_request", errorClass: "bad_request", retryAfter: null, status };
  if (status >= 500) return { type: "upstream_error", errorClass: "server_error", retryAfter: null, status: 502 };
  return { type: "upstream_error", errorClass: `http_${status}`, retryAfter: null, status: 502 };
}

// Human text for an error class. Never contains the upstream body (R3).
export function upstreamMessage(errorClass: string, status: number, provider: string): string {
  switch (errorClass) {
    case "project_denied": return "Google denied this project's Gemini API access. Use a key from another Google project or account.";
    case "project_restricted": return "This Google project's Gemini API access is restricted. Create a key in another project or enable billing.";
    case "auth_rejected": return `${provider} rejected the API key (${status}). Replace it under Bring your own key.`;
    case "rate_limited": return `${provider} says the rate limit or quota is used up (429). Try again later.`;
    case "model_not_found": return `${provider} doesn't know this model (404).`;
    case "bad_request": return `${provider} refused the request (${status}). Check the request body.`;
    case "server_error": return `${provider} failed (${status}). Try again later.`;
    case "timeout": return `${provider} didn't answer within ${UPSTREAM_TIMEOUT_MS / 1000} s.`;
    case "network": return `Can't reach ${provider}.`;
    case "bad_response": return `${provider} sent an answer Watchbell can't read.`;
    default: return `${provider} answered ${status}.`;
  }
}

async function failure(res: Response, provider: string): Promise<UpstreamError> {
  const text = await res.text().catch(() => "");
  const info = classifyUpstreamError(res.status, text);
  const header = Number(res.headers.get("retry-after"));
  if (info.retryAfter === null && Number.isFinite(header) && header > 0) info.retryAfter = Math.ceil(header);
  return new UpstreamError(info, upstreamMessage(info.errorClass, res.status, provider));
}

function networkError(e: unknown, provider: string): UpstreamError {
  const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
  const errorClass = timeout ? "timeout" : "network";
  return new UpstreamError({ type: "upstream_error", errorClass, retryAfter: null, status: timeout ? 504 : 502 }, upstreamMessage(errorClass, 0, provider));
}

function headersFor(conn: Pick<OpenConnection, "kind" | "secret">, accept: string): Record<string, string> {
  return { "content-type": "application/json", accept, ...authHeaders(conn.kind, conn.secret.apiKey) };
}

// POST {base}/chat/completions with the already rewritten body. Returns the raw upstream Response (status included);
// throws UpstreamError only when there is no answer at all (network failure, timeout).
export async function chat(conn: OpenConnection, body: ChatBody, signal: AbortSignal, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<Response> {
  try {
    return await fetch(`${conn.baseUrl}/chat/completions`, {
      method: "POST",
      headers: headersFor(conn, body.stream ? "text/event-stream" : "application/json"),
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      redirect: "error",
      cache: "no-store",
    });
  } catch (e) {
    if (signal.aborted) throw e; // the caller went away: the gateway records 499
    throw networkError(e, conn.name);
  }
}

// Models this connection offers, filtered to Google text models (Gemini/Antigravity, Workers AI Gemma).
const NOT_TEXT = /(tts|image|embedding|lyria|veo|aqa|imagen)/i;

export async function models(conn: Pick<OpenConnection, "kind" | "name" | "baseUrl" | "secret">, timeoutMs = 15_000): Promise<UpstreamModel[]> {
  const out: UpstreamModel[] = [];
  try {
    if (PRESETS[conn.kind].listModels === "gemini-native") {
      // The native list says which models support generateContent and their token limits; the OpenAI one doesn't.
      let page: string | null = null;
      for (let i = 0; i < 5; i++) {
        const url = new URL(`${GEMINI_NATIVE_BASE}/models`);
        url.searchParams.set("pageSize", "1000");
        if (page) url.searchParams.set("pageToken", page);
        const res = await fetch(url, { headers: headersFor(conn, "application/json"), signal: AbortSignal.timeout(timeoutMs), redirect: "error", cache: "no-store" });
        if (!res.ok) throw await failure(res, conn.name);
        const json = (await res.json()) as { models?: { name?: string; supportedGenerationMethods?: string[]; inputTokenLimit?: number; outputTokenLimit?: number }[]; nextPageToken?: string };
        for (const m of json.models ?? []) {
          const id = publicModelName(String(m.name ?? ""));
          if (!id || !m.supportedGenerationMethods?.includes("generateContent") || NOT_TEXT.test(id) || !isGatewayModel(id)) continue;
          out.push({ id, upstream: id, ...(m.inputTokenLimit ? { ctx: m.inputTokenLimit } : {}), ...(m.outputTokenLimit ? { out: m.outputTokenLimit } : {}) });
        }
        page = json.nextPageToken ?? null;
        if (!page) break;
      }
    } else if (PRESETS[conn.kind].listModels === "cloudflare-search") {
      // Workers AI has no OpenAI /models; its catalogue search lists text generation models with their properties.
      for (let page = 1; page <= 5; page++) {
        const url = new URL(`${CLOUDFLARE_API}/accounts/${encodeURIComponent(conn.secret.accountId ?? "")}/ai/models/search`);
        url.searchParams.set("task", "Text Generation");
        url.searchParams.set("per_page", "100");
        url.searchParams.set("page", String(page));
        const res = await fetch(url, { headers: headersFor(conn, "application/json"), signal: AbortSignal.timeout(timeoutMs), redirect: "error", cache: "no-store" });
        if (!res.ok) throw await failure(res, conn.name);
        const json = (await res.json()) as { result?: { name?: string; properties?: { property_id?: string; value?: unknown }[] }[] };
        const items = json.result ?? [];
        for (const m of items) {
          const upstream = String(m.name ?? "");
          if (!upstream || NOT_TEXT.test(upstream) || !isGatewayModel(upstream)) continue;
          const ctx = Number(m.properties?.find((p) => p.property_id === "context_window")?.value);
          out.push({ id: publicModelName(upstream), upstream, ...(Number.isFinite(ctx) && ctx > 0 ? { ctx } : {}) });
        }
        if (items.length < 100) break;
      }
    } else {
      const res = await fetch(`${conn.baseUrl}${PRESETS[conn.kind].modelsPath}`, { headers: headersFor(conn, "application/json"), signal: AbortSignal.timeout(timeoutMs), redirect: "error", cache: "no-store" });
      if (!res.ok) throw await failure(res, conn.name);
      const json = (await res.json()) as { data?: { id?: string; context_length?: number; context_window?: number }[] };
      for (const m of json.data ?? []) {
        const id = publicModelName(String(m.id ?? ""));
        // A custom server (the owner's own) keeps every id it lists (owner 14 Oct); other OpenAI-style presets filter.
        if (!id || (conn.kind !== "custom" && (NOT_TEXT.test(String(m.id)) || !isGatewayModel(String(m.id))))) continue;
        const ctx = m.context_length ?? m.context_window;
        out.push({ id, upstream: String(m.id), ...(ctx ? { ctx } : {}) });
      }
    }
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    if (e instanceof SyntaxError) throw new UpstreamError({ type: "upstream_error", errorClass: "bad_response", retryAfter: null, status: 502 }, upstreamMessage("bad_response", 0, conn.name));
    throw networkError(e, conn.name);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// A tiny generation call (owner finding 07:58: a project can list models and still be denied generateContent).
export async function testGenerate(conn: Pick<OpenConnection, "kind" | "name" | "baseUrl" | "secret">, model: string, timeoutMs = 20_000, maxTokens = 16): Promise<{ ok: true; ms: number } | { ok: false; status: number; errorClass: string; error: string }> {
  const started = Date.now();
  try {
    const res = PRESETS[conn.kind].listModels === "gemini-native"
      ? await fetch(`${GEMINI_NATIVE_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", headers: headersFor(conn, "application/json"), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }], generationConfig: { maxOutputTokens: maxTokens } }),
      })
      : await fetch(`${conn.baseUrl}/chat/completions`, {
        method: "POST", headers: headersFor(conn, "application/json"), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: maxTokens }),
      });
    if (res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: true, ms: Date.now() - started };
    }
    const err = await failure(res, conn.name);
    return { ok: false, status: res.status, errorClass: err.info.errorClass, error: err.message };
  } catch (e) {
    const err = networkError(e, conn.name);
    return { ok: false, status: 0, errorClass: err.info.errorClass, error: err.message };
  }
}

// Durations like "2m59.56s", "7.66s", "1h2m", "120ms" (Groq-style x-ratelimit-reset-*), or plain seconds.
export function parseResetDuration(v: string | null): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let ms = 0;
  let matched = "";
  for (let m = re.exec(s); m; m = re.exec(s)) {
    matched += m[0];
    const n = Number(m[1]);
    ms += m[2] === "h" ? n * 3_600_000 : m[2] === "m" ? n * 60_000 : m[2] === "s" ? n * 1000 : n;
  }
  return matched === s && matched ? Math.round(ms) : null;
}

// Rate-limit headers some OpenAI-compatible servers send (Groq style). Gemini sends none, so this is [] for it.
export function readQuota(conn: Pick<OpenConnection, "id">, model: string | null, headers: Headers, now: Date): QuotaObservation[] {
  const out: QuotaObservation[] = [];
  for (const metric of ["requests", "tokens"] as const) {
    const limit = headers.get(`x-ratelimit-limit-${metric}`);
    const remaining = headers.get(`x-ratelimit-remaining-${metric}`);
    if (limit === null && remaining === null) continue;
    const l = limit !== null && /^\d+$/.test(limit.trim()) ? Number(limit) : null;
    const r = remaining !== null && /^\d+$/.test(remaining.trim()) ? Number(remaining) : null;
    if (l === null && r === null) continue;
    const reset = parseResetDuration(headers.get(`x-ratelimit-reset-${metric}`));
    out.push({
      providerId: conn.id, scope: model ?? "all", metric, limit: l, remaining: r, used: l !== null && r !== null ? Math.max(0, l - r) : null,
      resetAt: reset !== null ? new Date(now.getTime() + reset) : null, source: "header",
    });
  }
  return out;
}
