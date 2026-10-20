import { retryAfterSeconds } from "@/lib/rate-limit";
import { detectClient } from "@/private/agents/detect";
import { apiError } from "@/private/api/respond";
import { hasScope, hashKey, parseBearer } from "@/private/keys/key";
import { authLookup } from "@/private/keys/keys-db";
import { SCOPES, type Scope } from "@/private/keys/scopes";

// Console API keys (R3). Every /api/v1 route calls authenticateApiKey first and returns `response` on failure (401
// invalid_api_key, 403 missing_scope, 429 key_rate_limit with Retry-After). The interface is Task 1's; the body is
// Task 2's: parse the bearer, ONE statement that finds the active key and counts this minute's call, then the checks.
export { SCOPES };
export type { Scope };

export type ApiKeyContext = {
  keyId: string; name: string; prefix: string; scopes: Scope[];
  ratePerMin: number; providerId: string | null; model: string | null;
  client: { name: string; version: string; via: "mcp" | "x-client" | "user-agent" | "unknown"; userAgent: string };
};

export type AuthFailure = { ok: false; response: Response };

const RATE_WINDOW_SECONDS = 60;

// The same answer for "no key", "malformed", "unknown", "revoked" and "expired": a caller learns nothing about which.
const invalid = () => apiError("invalid_api_key", "Send a console API key: Authorization: Bearer wb_…", 401);

export async function authenticateApiKey(req: Request, scope: Scope | "any"): Promise<{ ok: true; key: ApiKeyContext } | AuthFailure> {
  const token = parseBearer(req.headers.get("authorization"));
  if (!token) return { ok: false, response: invalid() };

  const now = new Date();
  let row;
  try {
    row = await authLookup(hashKey(token), now);
  } catch (e) {
    // Never log the error object: a driver error can carry the statement's parameters (the key's hash).
    console.error("api key lookup failed:", e instanceof Error ? e.name : "unknown");
    return { ok: false, response: apiError("upstream_error", "The console could not check this key right now. Try again.", 503) };
  }
  if (!row) return { ok: false, response: invalid() };

  if (!hasScope(row.scopes, scope)) {
    return { ok: false, response: apiError("missing_scope", scope === "any" ? "This key has no scopes." : `This key needs the ${scope} scope.`, 403) };
  }
  if (row.hits > row.ratePerMin) {
    const retry = retryAfterSeconds(now, RATE_WINDOW_SECONDS);
    return {
      ok: false,
      response: apiError("key_rate_limit", `This key is limited to ${row.ratePerMin} requests per minute.`, 429, { "Retry-After": String(retry) }),
    };
  }
  return {
    ok: true,
    key: {
      keyId: row.id, name: row.name, prefix: row.prefix, scopes: row.scopes, ratePerMin: row.ratePerMin,
      providerId: row.providerId, model: row.model, client: detectClient(req.headers),
    },
  };
}
