import { createHash } from "node:crypto";
import { memoryLimiter, negativeCache, requestIp } from "@/lib/memory-limit";
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

// Watchbell 1.2.1 (audit M2): failed keys (missing, malformed or unknown) per caller IP, in memory per server instance,
// checked before the database lookup, so guessing keys can't keep the pooler's few slots busy. A known key is never
// counted; its own per-minute limit applies in the lookup.
// Review m1: only DISTINCT failing keys count per IP (an agent left running with a revoked key counts once, so the
// valid keys on that machine go on), and a key that just failed is answered 401 for a minute without a lookup.
export const KEY_FAILURES_PER_IP = { max: 30, windowMs: 10 * 60_000 } as const;
export const FAILED_KEY_TTL_MS = 60_000;
type Failures = {
  limit: ReturnType<typeof memoryLimiter>; seen: ReturnType<typeof negativeCache>; failed: ReturnType<typeof negativeCache>; reset: () => void;
};
export const keyFailures: Failures = ((globalThis as { __watchbellKeyFailures?: Failures }).__watchbellKeyFailures ??= (() => {
  const t = { limit: memoryLimiter(KEY_FAILURES_PER_IP), seen: negativeCache({ ttlMs: KEY_FAILURES_PER_IP.windowMs, maxKeys: 50_000 }), failed: negativeCache({ ttlMs: FAILED_KEY_TTL_MS }) };
  return { ...t, reset: () => { t.limit.reset(); t.seen.reset(); t.failed.reset(); } };
})());
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

export async function authenticateApiKey(req: Request, scope: Scope | "any"): Promise<{ ok: true; key: ApiKeyContext } | AuthFailure> {
  const ip = requestIp(req.headers);
  if (ip) {
    const q = keyFailures.limit.peek(ip);
    if (!q.allowed) {
      return { ok: false, response: apiError("key_rate_limit", "Too many failed key attempts from this network. Try again later.", 429, { "Retry-After": String(q.retryAfter) }) };
    }
  }
  const presented = digest(req.headers.get("authorization") ?? "");
  const failed = (): AuthFailure => {
    keyFailures.failed.add(presented);
    if (ip && !keyFailures.seen.has(`${ip} ${presented}`)) {
      keyFailures.seen.add(`${ip} ${presented}`);
      keyFailures.limit.count(ip);
    }
    return { ok: false, response: invalid() };
  };
  if (keyFailures.failed.has(presented)) return failed();
  const token = parseBearer(req.headers.get("authorization"));
  if (!token) return failed();

  const now = new Date();
  let row;
  try {
    row = await authLookup(hashKey(token), now);
  } catch (e) {
    // Never log the error object: a driver error can carry the statement's parameters (the key's hash).
    console.error("api key lookup failed:", e instanceof Error ? e.name : "unknown");
    return { ok: false, response: apiError("upstream_error", "The console could not check this key right now. Try again.", 503) };
  }
  if (!row) return failed();

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
