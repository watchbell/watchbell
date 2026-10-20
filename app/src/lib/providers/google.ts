import { createSign } from "node:crypto";
import { z } from "zod";
import { callJson, type FetchOpts, formatFailure, type Result } from "./http";

// A Google service account signs its own short-lived assertion (RS256) and trades it for a 1-hour access token
// (developers.google.com/identity/protocols/oauth2/service-account). No firebase-admin: the console needs four reads,
// and the SDK's size and cold start aren't worth it. The token endpoint is fixed: the JSON's token_uri is never used.
export const serviceAccountSchema = z.object({
  type: z.literal("service_account"),
  project_id: z.string().min(1),
  client_email: z.email(),
  private_key: z.string().includes("PRIVATE KEY"),
  private_key_id: z.string().optional(),
});
export type ServiceAccount = z.infer<typeof serviceAccountSchema>;

export function parseServiceAccount(json: string): ServiceAccount | null {
  try {
    const p = serviceAccountSchema.safeParse(JSON.parse(json));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
// What the IAM viewer roles allow is what limits access; these scopes only let the token reach the four APIs.
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/datastore",
  "https://www.googleapis.com/auth/identitytoolkit",
  "https://www.googleapis.com/auth/monitoring.read",
  "https://www.googleapis.com/auth/firebase.readonly",
] as const;

const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");

export function signJwt(sa: ServiceAccount, nowS: number): string {
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT", ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) }));
  const claims = b64(JSON.stringify({ iss: sa.client_email, scope: GOOGLE_SCOPES.join(" "), aud: TOKEN_URL, iat: nowS, exp: nowS + 3600 }));
  const sig = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(sa.private_key);
  return `${header}.${claims}.${b64(sig)}`;
}

export async function googleAccessToken(sa: ServiceAccount, opts: FetchOpts & { now?: Date } = {}): Promise<Result<string>> {
  let assertion: string;
  try {
    assertion = signJwt(sa, Math.floor((opts.now ?? new Date()).getTime() / 1000));
  } catch {
    return { ok: false, kind: "auth", error: "The private key in this service account can't be used. Paste the whole JSON file again." };
  }
  const form = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
  const r = await callJson("Google", TOKEN_URL, { method: "POST", form }, opts);
  if (!r.ok) return r.kind === "auth" ? { ...r, error: "Google rejected this service account (its key was deleted or disabled). Create a new key." } : r;
  const p = z.object({ access_token: z.string().min(1) }).safeParse(r.data);
  return p.success ? { ok: true, data: p.data.access_token } : formatFailure("Google", "the access token");
}
