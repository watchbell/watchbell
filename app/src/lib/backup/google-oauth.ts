import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ENV_COPY } from "@/lib/copy/edition";
import { z } from "zod";

// Spec §11: the Owner connects Google Drive once with OAuth (Authorization Code + PKCE), scope drive.file only (the
// console sees only the files it creates; non-sensitive, so no Google verification). Plain fetch, no SDK. The client id
// and secret are env vars; the refresh token is stored sealed in ops.accounts (lib/crypto), never here.

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const DRIVE_ENV_MISSING = ENV_COPY.notSet("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET", true);
// What an invalid_grant becomes on the account row: lib/alerts/evaluate.ts fires CredentialExpiring on "invalid_grant".
export const INVALID_GRANT = "invalid_grant: Google Drive access was removed or has expired. Reconnect Google Drive.";

export type DriveEnv = { clientId: string; clientSecret: string };
export type FetchOpts = { fetch?: typeof fetch; timeoutMs?: number };
// revoked: invalid_grant (access removed, password changed, 6 months unused, Testing-mode 7 days). client: the OAuth
// client itself was refused (wrong id or secret). scope: the grant doesn't include drive.file.
export type TokenFailure = { ok: false; kind: "revoked" | "client" | "scope" | "transient" | "format"; error: string };

export function driveEnv(source: Record<string, string | undefined> = process.env): DriveEnv | null {
  const clientId = source.GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = source.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  if (!clientSecret || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) return null;
  return { clientId, clientSecret };
}

export const redirectUri = (siteUrl: string): string => `${siteUrl.replace(/\/+$/, "")}/auth/google/callback`;

export const newState = (): string => randomBytes(32).toString("base64url");
export const challengeOf = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

// RFC 7636: a 43–128 character verifier; 64 random bytes give 86.
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString("base64url");
  return { verifier, challenge: challengeOf(verifier) };
}

export function sameState(expected: string, got: string | null | undefined): boolean {
  if (!got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

// prompt=consent with access_type=offline: Google returns a refresh token on every connect, so Reconnect always works.
export function authUrl(env: DriveEnv, p: { state: string; challenge: string; redirectUri: string }): string {
  const q = new URLSearchParams({
    client_id: env.clientId, redirect_uri: p.redirectUri, response_type: "code", scope: DRIVE_SCOPE,
    access_type: "offline", prompt: "consent", state: p.state, code_challenge: p.challenge, code_challenge_method: "S256",
  });
  return `${GOOGLE_AUTH_URL}?${q}`;
}

const oauthError = z.object({ error: z.string() });

async function postToken(form: URLSearchParams, opts: FetchOpts): Promise<{ ok: true; body: unknown } | TokenFailure> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(GOOGLE_TOKEN_URL, {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(), signal: AbortSignal.timeout(timeoutMs), cache: "no-store",
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, kind: "transient", error: timedOut ? `Google didn't answer within ${Math.round(timeoutMs / 1000)} seconds.` : "Couldn't reach Google." };
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) return { ok: true, body };
  // Only the error code is used: Google's description is never stored or shown.
  const code = oauthError.safeParse(body).success ? (body as { error: string }).error : null;
  if (code === "invalid_grant") return { ok: false, kind: "revoked", error: INVALID_GRANT };
  if (code === "invalid_client" || code === "unauthorized_client") {
    return { ok: false, kind: "client", error: `Google refused the OAuth client. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET ${ENV_COPY.checkWhere}.` };
  }
  if (res.status === 429 || res.status >= 500) return { ok: false, kind: "transient", error: `Google returned an error (${res.status}). The next run tries again.` };
  return { ok: false, kind: "format", error: `Google refused the request (${code ?? res.status}).` };
}

const exchanged = z.object({ refresh_token: z.string().min(1), scope: z.string().optional() });

export async function exchangeCode(env: DriveEnv, p: { code: string; verifier: string; redirectUri: string }, opts: FetchOpts = {}):
  Promise<{ ok: true; refreshToken: string; scope: string } | TokenFailure> {
  const r = await postToken(new URLSearchParams({
    grant_type: "authorization_code", code: p.code, code_verifier: p.verifier, redirect_uri: p.redirectUri,
    client_id: env.clientId, client_secret: env.clientSecret,
  }), opts);
  if (!r.ok) return r;
  const t = exchanged.safeParse(r.body);
  if (!t.success) return { ok: false, kind: "format", error: "Google didn't send a refresh token. Remove Watchbell's access in your Google Account and connect again." };
  const scope = t.data.scope ?? "";
  if (!scope.split(/\s+/).includes(DRIVE_SCOPE)) return { ok: false, kind: "scope", error: "The Drive permission wasn't granted. Connect again and allow it." };
  return { ok: true, refreshToken: t.data.refresh_token, scope };
}

const refreshed = z.object({ access_token: z.string().min(1) });

export async function refreshAccessToken(env: DriveEnv, refreshToken: string, opts: FetchOpts = {}): Promise<{ ok: true; accessToken: string } | TokenFailure> {
  const r = await postToken(new URLSearchParams({
    grant_type: "refresh_token", refresh_token: refreshToken, client_id: env.clientId, client_secret: env.clientSecret,
  }), opts);
  if (!r.ok) return r;
  const t = refreshed.safeParse(r.body);
  return t.success ? { ok: true, accessToken: t.data.access_token } : { ok: false, kind: "format", error: "Google answered the token request in a format the console doesn't recognise." };
}
