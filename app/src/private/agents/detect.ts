import type { ApiKeyContext } from "@/private/auth/api-key";

// Agents are detected from their requests, never registered (R6). Pure: headers in, a client identity out.
type Client = ApiKeyContext["client"];

const MAX_NAME = 40;
const MAX_VERSION = 24;
const MAX_UA = 200;
const ACTIVE_MS = 30 * 60_000;

// [a-z0-9._-]{1,40}, lower-cased. Anything else becomes a dash (runs collapse), edges are trimmed. "" when nothing
// usable is left, so the detector falls through to the next source.
export function sanitizeName(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, MAX_NAME).replace(/[-.]+$/, "");
}

// [A-Za-z0-9._+-]{0,24}: unlike a name, a version just drops the characters it can't hold.
export function sanitizeVersion(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.replace(/[^A-Za-z0-9._+-]/g, "").slice(0, MAX_VERSION);
}

// What is stored of the User-Agent: control characters out, at most 200 characters.
function cleanUserAgent(s: string | null): string {
  return (s ?? "").replace(/[\u0000-\u001f\u007f]/g, (c) => (c === "\t" ? " " : "")).slice(0, MAX_UA);
}

// "name/version" (X-Client) or the first product token of a User-Agent ("GeminiCLI/0.9.0 (win32; x64)").
function product(value: string | null): { name: string; version: string } | null {
  const first = (value ?? "").trim().split(/\s+/)[0] ?? "";
  const [rawName, ...rest] = first.split("/");
  const name = sanitizeName(rawName);
  return name ? { name, version: sanitizeVersion(rest.join("/")) } : null;
}

export function detectClient(headers: Headers, mcp?: { name?: unknown; version?: unknown }): Client {
  const userAgent = cleanUserAgent(headers.get("user-agent"));
  const mcpName = sanitizeName(mcp?.name);
  if (mcpName) return { name: mcpName, version: sanitizeVersion(mcp?.version), via: "mcp", userAgent };
  const xClient = product(headers.get("x-client"));
  if (xClient) return { ...xClient, via: "x-client", userAgent };
  const ua = product(userAgent);
  if (ua) return { ...ua, via: "user-agent", userAgent };
  return { name: "unknown", version: "", via: "unknown", userAgent };
}

export type AgentStatus = "active" | "idle" | "revoked";

// Active ≤ 30 min since last seen, Idle after, "Key revoked" when the key is revoked.
export function agentStatus(lastSeen: Date, keyRevoked: boolean, now: Date): AgentStatus {
  if (keyRevoked) return "revoked";
  return now.getTime() - lastSeen.getTime() <= ACTIVE_MS ? "active" : "idle";
}

// The owner's rename of an agent: letters, digits, spaces and . _ - only, up to 40 characters ("" resets it).
export const DISPLAY_NAME_RE = /^[\p{L}\p{N} ._-]{0,40}$/u;
