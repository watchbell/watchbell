import { scrubLog } from "@/lib/logs/scrub";
import { type AliasBook, hideNames } from "@/lib/view/display-name";
import { AI_ALLOWED_MODELS_DEFAULT, allowedModel, MODEL_RE, normalizeModel, stripProvider } from "@/private/ai/types";

// R5 for everything an MCP tool returns (pure). The data layer already builds scrubbed objects; this is the last pass
// over every string of a tool result, so nothing below can leak even if a reader adds a field later:
// database names → aliases (db-a), emails hidden, log secrets masked (scrubLog), URLs in free text → "[link]" (other
// schemes such as postgres:// gone whole), known hosts → their alias, IPv4 addresses and key-shaped tokens hidden.

const ESC = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const URL_RE = /\b([a-z][a-z0-9+.-]{1,20}):\/\/[^\s"'<>`]*/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// Console keys, heartbeat tokens and provider keys that a message might carry (R5 leak list).
const TOKENS = /\b(?:w[bp]_[A-Za-z0-9]{6,}|hb_[A-Za-z0-9[\]]{2,}|sk-[A-Za-z0-9_-]{6,}|gsk_[A-Za-z0-9]{6,}|AIza[0-9A-Za-z_-]{10,}|AQ\.[A-Za-z0-9_-]{10,})/g;
const VERCEL_HOST = /(?<![\p{L}\p{N}_.-])[a-z0-9-]+\.vercel\.app(?![\p{L}\p{N}_-])/giu;
// "@" left after emails are hidden (a handle, "user@localhost"): spelled out so the text can't pass for an address.
const AT = /@/g;

const hostRes = new WeakMap<AliasBook, { re: RegExp; alias: Map<string, string> } | null>();
function hostsOf(book: AliasBook) {
  if (hostRes.has(book)) return hostRes.get(book)!;
  const list = [...(book.host ?? [])].filter((h) => h.name.includes(".")).sort((a, b) => b.name.length - a.name.length);
  const built = list.length
    ? { re: new RegExp(`(?<![\\p{L}\\p{N}_-])((?:[a-z0-9-]+\\.)*?)(${list.map((h) => ESC(h.name)).join("|")})(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, "giu"), alias: new Map(list.map((h) => [h.name.toLowerCase(), h.alias])) }
    : null;
  hostRes.set(book, built);
  return built;
}

// A URL in free text: a web link becomes "[link]" (its host and path can name a project or carry an id), anything
// else (postgres://, redis://, …) "[hidden]". Monitor and log paths are separate fields and stay.
function urlToPath(_all: string, scheme: string): string {
  return /^https?$/i.test(scheme) ? "[link]" : "[hidden]";
}

export function scrubText(text: string, book: AliasBook): string {
  let out = text.replace(URL_RE, urlToPath);
  out = hideNames(out, book);
  out = scrubLog(out);
  out = out.replace(TOKENS, "[hidden]");
  const h = hostsOf(book);
  if (h) out = out.replace(h.re, (_a, sub: string, host: string) => `${sub}${h.alias.get(host.toLowerCase()) ?? "site.example"}`);
  out = out.replace(VERCEL_HOST, "preview.example").replace(IPV4, "[ip]").replace(AT, " at ");
  return out;
}

// Every string in a JSON-able value, keys included only as they are (they are ours). Dates become ISO strings.
export function scrubDeep(value: unknown, book: AliasBook): unknown {
  if (typeof value === "string") return scrubText(value, book);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, book));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).map(([k, v]) => [k, scrubDeep(v, book)]));
  }
  return value;
}

// Which models the MCP write tools (submit_ai_note, answer_question) accept. Controller rulings 13 Oct: Google models
// (gemini*, antigravity*, Workers AI's @cf/google/gemma*) and, owner update ~08:45, the Claude models Antigravity
// itself offers (claude*: "claude-sonnet-4-6", "Claude Opus 4.6 (Thinking)"). The owner may override the list in
// ops.settings `ai.allowedModels` (a JSON string array of prefixes, read by notes-db.allowedModels()).
// Matching: the reported model is normalised (trimmed, lower-cased, spaces and brackets → "-") and a "provider/" prefix
// is stripped ("google/gemini-3.8-flash", "models/gemini-…", "cloudflare/@cf/google/gemma-3-12b-it"; "@cf/…" ids keep
// their slashes), then it must start with one of the prefixes.
export const MCP_ALLOWED_MODELS: readonly string[] = AI_ALLOWED_MODELS_DEFAULT;
export { allowedModel, MODEL_RE, normalizeModel, stripProvider };

export function isMcpModelAllowed(model: unknown, allowed: readonly string[] = MCP_ALLOWED_MODELS): boolean {
  return allowedModel(model, allowed) !== null;
}
