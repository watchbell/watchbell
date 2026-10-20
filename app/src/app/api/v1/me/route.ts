import { recordApiCall } from "@/private/ai/usage";
import { apiJson } from "@/private/api/respond";
import { authenticateApiKey } from "@/private/auth/api-key";
import { keyExpiry } from "@/private/keys/keys-db";

export const dynamic = "force-dynamic";

// Who am I: the key's own details, for an agent or an app to check its configuration. Any scope will do. Never the
// key, its hash or the owner's identity. It also records the call, so a key that only ever calls /me still shows its
// agent on the Agents page.
export async function GET(req: Request): Promise<Response> {
  const started = Date.now();
  const auth = await authenticateApiKey(req, "any");
  if (!auth.ok) return auth.response;
  const { key } = auth;
  const expiresAt = await keyExpiry(key.keyId);
  recordApiCall(key, "me", null, started, 200);
  return apiJson({
    name: key.name,
    prefix: key.prefix,
    scopes: key.scopes,
    rateLimitPerMin: key.ratePerMin,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  });
}
