import { serviceAccountSchema } from "./google";
import { type Provider, PROVIDER_INFO } from "./info";
import { parseUpstashCred } from "./upstash";

export { serviceAccountSchema };

export const BAD_SERVICE_ACCOUNT = "Paste the whole JSON file. It needs client_email and private_key.";

export function normalizeCredential(provider: Provider, raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const info = PROVIDER_INFO[provider];
  const trimmed = raw.trim();
  if (info.json) {
    try {
      const parsed = serviceAccountSchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) return { ok: true, value: trimmed };
    } catch {
      // fall through to the message below
    }
    return { ok: false, error: BAD_SERVICE_ACCOUNT };
  }
  const value = trimmed.replace(/^bearer\s+/i, "").replace(/^["']|["']$/g, "").trim();
  // "Scoped access token" -> "access token"; "Access token" -> "access token"; "API key" stays "API key".
  const kind = info.credentialKind.replace(/^Scoped /, "").replace(/^([A-Z][a-z])/, (m) => m.toLowerCase());
  const article = /^[aeiou]/i.test(kind) ? "an" : "a";
  if (!value) return { ok: false, error: `Paste the ${kind}.` };
  if (value.length < 20) return { ok: false, error: `That's too short for ${article} ${kind}.` };
  // Stage 8: Upstash signs with the account email and a Developer API key; both go in the one sealed credential.
  if (provider === "upstash") {
    return parseUpstashCred(value) ? { ok: true, value } : { ok: false, error: "Paste your Upstash email and the API key as email:API_KEY." };
  }
  // Stage 7: only fine-grained GitHub tokens can be limited to read-only (Metadata, Contents, Actions read).
  if ((provider === "github" || provider === "github_write") && !/^github_pat_[A-Za-z0-9_]{20,}$/.test(value)) {
    return { ok: false, error: "Use a fine-grained token (it starts with github_pat_). Classic tokens can't be limited to read-only." };
  }
  return { ok: true, value };
}
