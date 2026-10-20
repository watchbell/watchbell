// Every /api/v1 answer goes through these two: JSON, never cached (a key's data must not sit in a shared cache).
// X-Content-Type-Options and the other security headers come from next.config.ts. No CORS: callers are servers, agents
// and the same-origin API explorer.

export type ApiErrorType =
  | "invalid_api_key" | "missing_scope" | "key_rate_limit" | "model_not_enabled" | "provider_not_connected"
  | "upstream_error" | "quota_exceeded" | "invalid_request" | "not_found" | "method_not_allowed";

function noStore(headers?: HeadersInit): Headers {
  const h = new Headers(headers);
  h.set("Cache-Control", "no-store");
  return h;
}

// OpenAI-style error body (R4): { error: { type, message } }. The message must never carry a secret or an upstream body.
export function apiError(type: ApiErrorType, message: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error: { type, message } }, { status, headers: noStore(headers) });
}

export function apiJson(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, { ...init, headers: noStore(init?.headers) });
}
