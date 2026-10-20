// Client-safe constants for console API keys (no node:crypto, no DB): the Create key dialog imports these. The server
// side (hash, bearer parsing, schema) is in ./key.ts; `@/private/auth/api-key` re-exports SCOPES for the routes.
import { KEYS_COPY } from "@/lib/copy/edition";

export const SCOPES = ["ai:invoke", "read:status", "write:notes"] as const;
export type Scope = (typeof SCOPES)[number];

export const SCOPE_INFO: Record<Scope, { short: string; long: string }> = {
  "ai:invoke": { short: "models", long: "Chat completions and the model list through your provider connections." },
  "read:status": { short: "console data, MCP", long: "Read-only console data: GET /api/v1/status and the MCP server. Database names are aliases; no URLs, emails or secrets." },
  "write:notes": { short: "post AI notes", long: KEYS_COPY.writeNotesLong },
};

// write:notes is never ticked by default (R8).
export const DEFAULT_SCOPES: Scope[] = ["ai:invoke"];

export const EXPIRY_CHOICES = ["7d", "30d", "90d", "1y", "never"] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];
export const EXPIRY_LABELS: Record<ExpiryChoice, string> = { "7d": "In 7 days", "30d": "In 30 days", "90d": "In 90 days", "1y": "In 1 year", never: "Never" };
export const DEFAULT_EXPIRY: ExpiryChoice = "90d";

export const DEFAULT_RATE_PER_MIN = 20;
export const MAX_RATE_PER_MIN = 600;
// R7: at most 20 active (not revoked, not expired) keys.
export const MAX_ACTIVE_KEYS = 20;
export const KEY_LIMIT_MESSAGE = "At most 20 active keys. Revoke one first.";
