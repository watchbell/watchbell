import "server-only";
import { sanitizeName, sanitizeVersion } from "@/private/agents/detect";
import type { UsageRecord } from "@/private/ai/types";
import { recordCall } from "@/private/ai/usage";
import type { ApiKeyContext } from "@/private/auth/api-key";

// Agent detection and usage rows for MCP calls (R6). Stage 5c integration: the name/version rules are Task 2's
// (@/private/agents/detect, the same ones detectClient applies to clientInfo) and the write is Task 3's shared
// recordCall, so the Agents and Logs pages count MCP calls exactly like AI and REST calls.

type Client = ApiKeyContext["client"];
export type ClientInfo = { name?: unknown; version?: unknown };
export { sanitizeName, sanitizeVersion };

// MCP clientInfo wins over what the headers said (R6); without a usable name the header-detected client stays.
export function mcpClient(detected: Client, info: ClientInfo | null | undefined): Client {
  const name = sanitizeName(info?.name);
  return name ? { name, version: sanitizeVersion(info?.version), via: "mcp", userAgent: detected.userAgent } : detected;
}

// "antigravity/1.4" as ai_notes.client and ai_questions.answered_by_client show it (≤ 80 chars).
export const clientLabel = (c: Client): string => (c.version ? `${c.name}/${c.version}` : c.name).slice(0, 80);

// Stateless transport, best effort: the last clientInfo a key sent with `initialize` (legacy clients send it only
// there), so later tools/call rows of the same key keep the MCP name. Per server instance; bounded.
const lastInfo = new Map<string, { name: string; version: string }>();
const MAX_KEYS = 100;

export function rememberClient(keyId: string, c: Client): void {
  if (c.via !== "mcp") return;
  lastInfo.delete(keyId);
  lastInfo.set(keyId, { name: c.name, version: c.version });
  if (lastInfo.size > MAX_KEYS) lastInfo.delete(lastInfo.keys().next().value as string);
}

export function rememberedClient(keyId: string): ClientInfo | null {
  return lastInfo.get(keyId) ?? null;
}

export function forgetClients(): void {
  lastInfo.clear();
}

// One recordCall statement: the key's last_used_at, the (key, client) agent upsert (requests + 1, the tool first in
// `recent`, at most 10) and the ai_usage row (kind 'mcp', tool). No quota rows (no provider is involved).
export async function recordMcpCall(rec: UsageRecord): Promise<void> {
  if (!rec.client || !rec.keyId) return;
  await recordCall(rec, []);
}
