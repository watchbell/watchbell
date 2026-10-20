import { z } from "zod";
import { type DriveEnv, GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL } from "@/lib/backup/google-oauth";

// Stage 6 create requests, Firebase (owner 16 Oct): the Owner's separate "Connect Google (create projects)" grant. The
// existing service accounts are viewer-only and the Drive grant is drive.file only, so creating a project needs the
// Owner's own OAuth consent with the cloud-platform scope (Cloud Resource Manager projects.create accepts no narrower
// scope; addFirebase accepts it too). Same OAuth client as Drive (GOOGLE_CLIENT_ID/SECRET), Authorization Code + PKCE,
// its own ticket cookie and callback (/auth/google/create/callback). The refresh token is sealed in ops.settings
// (key create.google); it is used only inside an approved Firebase create. Pure apart from fetch.

export const GCP_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
export const CREATE_COOKIE = "wp_gcp_oauth";
export const CREATE_COOKIE_PATH = "/auth/google/create";
export const CREATE_GRANT_KEY = "create.google";

export const createRedirectUri = (siteUrl: string): string => `${siteUrl.replace(/\/+$/, "")}/auth/google/create/callback`;

export function createAuthUrl(env: DriveEnv, p: { state: string; challenge: string; redirectUri: string }): string {
  const q = new URLSearchParams({
    client_id: env.clientId, redirect_uri: p.redirectUri, response_type: "code", scope: GCP_SCOPE,
    access_type: "offline", prompt: "consent", include_granted_scopes: "false", state: p.state, code_challenge: p.challenge, code_challenge_method: "S256",
  });
  return `${GOOGLE_AUTH_URL}?${q}`;
}

export type ExchangeResult = { ok: true; refreshToken: string } | { ok: false; kind: "scope" | "refused" | "transient"; error: string };

// Only Google's error code is ever read; its description is never stored or shown.
export async function exchangeCreateCode(env: DriveEnv, p: { code: string; verifier: string; redirectUri: string }, opts: { fetch?: typeof fetch } = {}): Promise<ExchangeResult> {
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(GOOGLE_TOKEN_URL, {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: p.code, code_verifier: p.verifier, redirect_uri: p.redirectUri, client_id: env.clientId, client_secret: env.clientSecret }).toString(),
      signal: AbortSignal.timeout(10_000), cache: "no-store",
    });
  } catch {
    return { ok: false, kind: "transient", error: "Couldn't reach Google." };
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, kind: res.status >= 500 || res.status === 429 ? "transient" : "refused", error: `Google refused the authorisation (${res.status}).` };
  const t = z.object({ refresh_token: z.string().min(1), scope: z.string().optional() }).safeParse(body);
  if (!t.success) return { ok: false, kind: "scope", error: "Google didn't send a refresh token. Remove Watchbell's access in your Google Account and connect again." };
  if (!(t.data.scope ?? "").split(/\s+/).includes(GCP_SCOPE)) return { ok: false, kind: "scope", error: "The Google Cloud permission wasn't granted. Connect again and allow it." };
  return { ok: true, refreshToken: t.data.refresh_token };
}
