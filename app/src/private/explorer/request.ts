import { type ApiOp, needsKey, type OpExample } from "@/private/openapi/operations";

// The explorer's request builder (pure, client-safe). R10: Try it runs in the browser with fetch to the SAME origin
// only (a relative path), the key and any pasted token live in React state and are never stored or sent anywhere else.

export type Row = { name: string; value: string };
export type Builder = { path: Record<string, string>; query: Row[]; headers: Row[]; body: string };

export function initialBuilder(op: ApiOp): Builder {
  return {
    path: Object.fromEntries(op.params.filter((p) => p.in === "path").map((p) => [p.name, p.default ?? ""])),
    query: op.params.filter((p) => p.in === "query").map((p) => ({ name: p.name, value: p.default ?? "" })),
    headers: op.params.filter((p) => p.in === "header").map((p) => ({ name: p.name, value: p.default ?? "" })),
    body: op.body ?? "",
  };
}

// An example (from the spec or saved) on top of the starting request: its values replace the named rows, new names are
// added, everything it doesn't mention goes back to the start.
export function applyExample(op: ApiOp, ex: Pick<OpExample, "query" | "path" | "headers" | "body">): Builder {
  const base = initialBuilder(op);
  const merge = (rows: Row[], given: Record<string, string> | undefined): Row[] => {
    if (!given) return rows;
    const out = rows.map((r) => (r.name in given ? { ...r, value: given[r.name] } : r));
    for (const [name, value] of Object.entries(given)) if (!out.some((r) => r.name === name)) out.push({ name, value });
    return out;
  };
  return {
    path: { ...base.path, ...(ex.path ?? {}) },
    query: merge(base.query, ex.query),
    headers: merge(base.headers, ex.headers),
    body: ex.body ?? base.body,
  };
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\x20-\x7e]*$/;
const FORBIDDEN = new Set(["authorization", "cookie", "proxy-authorization", "host", "content-length"]);

export type BuiltRequest = {
  method: string;
  // Relative to this deployment: the browser can only reach the same origin with it.
  path: string;
  // The absolute address, for display.
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
};

export function buildRequest(op: ApiOp, b: Builder, key: string, origin: string): { ok: true; request: BuiltRequest } | { ok: false; error: string } {
  let path = op.path;
  for (const p of op.params.filter((x) => x.in === "path")) {
    const v = (b.path[p.name] ?? "").trim();
    if (!v) return { ok: false, error: `Fill in the path parameter ${p.name}.` };
    path = path.replace(`{${p.name}}`, encodeURIComponent(v));
  }
  const qs = new URLSearchParams();
  for (const q of b.query) {
    const name = q.name.trim();
    const value = q.value.trim();
    if (!name) continue;
    if (!value) {
      if (op.params.some((p) => p.in === "query" && p.name === name && p.required)) return { ok: false, error: `Fill in the query parameter ${name}.` };
      continue;
    }
    qs.append(name, value);
  }
  const headers: Record<string, string> = {};
  for (const h of b.headers) {
    const name = h.name.trim();
    const value = h.value.trim();
    if (!name && !value) continue;
    if (!HEADER_NAME.test(name)) return { ok: false, error: `"${name.slice(0, 40)}" isn't a valid header name.` };
    if (FORBIDDEN.has(name.toLowerCase())) return { ok: false, error: `${name} can't be set here${name.toLowerCase() === "authorization" ? ": use the key field" : ""}.` };
    if (!HEADER_VALUE.test(value)) return { ok: false, error: `The value of ${name} has characters a header can't carry.` };
    if (value) headers[name] = value;
  }
  if (needsKey(op)) {
    const k = key.trim();
    if (!k) return { ok: false, error: `Paste a console API key first${op.scope && op.scope !== "any" ? ` (this endpoint needs ${op.scope})` : ""}.` };
    if (!/^[\x21-\x7e]+$/.test(k)) return { ok: false, error: "That key has spaces or characters a key never has. Paste it again." };
    headers.Authorization = `Bearer ${k}`;
  }
  let body: string | undefined;
  if (op.body !== undefined) {
    body = b.body.trim();
    if (!body) return { ok: false, error: "The JSON body is empty." };
    try {
      JSON.parse(body);
    } catch (e) {
      return { ok: false, error: `The body isn't valid JSON${e instanceof SyntaxError ? `: ${e.message.slice(0, 120)}` : "."}` };
    }
    if (!Object.keys(headers).some((n) => n.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
  }
  const rel = path + (qs.size ? `?${qs.toString()}` : "");
  return { ok: true, request: { method: op.method.toUpperCase(), path: rel, url: origin.replace(/\/+$/, "") + rel, headers, body } };
}

// ---- the response viewer ------------------------------------------------------------------------------------------

export const MAX_SHOWN_CHARS = 200_000;

export type ShownResponse = {
  status: number; statusText: string; tone: "ok" | "warn" | "err"; ms: number; bytes: number;
  headers: [string, string][]; body: string; truncated: boolean;
};

export const statusTone = (status: number): ShownResponse["tone"] => (status >= 200 && status < 300 ? "ok" : status >= 300 && status < 400 ? "warn" : "err");

export function describeResponse(r: { status: number; statusText: string; headers: [string, string][]; text: string; ms: number }): ShownResponse {
  const type = r.headers.find(([n]) => n.toLowerCase() === "content-type")?.[1] ?? "";
  let body = r.text;
  if (type.includes("json") || /^\s*[{[]/.test(r.text)) {
    try {
      body = JSON.stringify(JSON.parse(r.text), null, 2);
    } catch { /* not JSON (a stream, or a truncated answer): show it as it came */ }
  }
  const truncated = body.length > MAX_SHOWN_CHARS;
  return {
    status: r.status, statusText: r.statusText, tone: statusTone(r.status), ms: Math.round(r.ms), bytes: new TextEncoder().encode(r.text).length,
    headers: [...r.headers].sort(([a], [b]) => a.localeCompare(b)), body: truncated ? body.slice(0, MAX_SHOWN_CHARS) : body, truncated,
  };
}

export const sizeText = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

// HTTP/2 answers carry no reason phrase, so the viewer names the common ones itself.
const REASONS: Record<number, string> = {
  200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 301: "Moved Permanently", 302: "Found", 304: "Not Modified", 400: "Bad Request", 401: "Unauthorized",
  403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 408: "Request Timeout", 413: "Payload Too Large", 429: "Too Many Requests", 500: "Internal Server Error",
  502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};
export const statusWord = (status: number, statusText: string): string => `${status} ${statusText || REASONS[status] || ""}`.trim();
