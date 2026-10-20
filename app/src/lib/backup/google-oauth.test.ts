import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ENV_COPY } from "@/lib/copy/edition";
import {
  authUrl, challengeOf, DRIVE_ENV_MISSING, DRIVE_SCOPE, driveEnv, exchangeCode, GOOGLE_TOKEN_URL, newState, pkcePair, redirectUri,
  refreshAccessToken, sameState,
} from "./google-oauth";

const env = { clientId: "1234-fake.apps.googleusercontent.com", clientSecret: "fake-client-secret" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("driveEnv", () => {
  it("reads both variables, trimmed", () => {
    expect(driveEnv({ GOOGLE_CLIENT_ID: " 1234-fake.apps.googleusercontent.com\n", GOOGLE_CLIENT_SECRET: " fake-client-secret " })).toEqual(env);
  });
  it("is null when either is missing or the id isn't a Google OAuth client id", () => {
    expect(driveEnv({})).toBeNull();
    expect(driveEnv({ GOOGLE_CLIENT_ID: env.clientId })).toBeNull();
    expect(driveEnv({ GOOGLE_CLIENT_ID: "not-a-client-id", GOOGLE_CLIENT_SECRET: "x" })).toBeNull();
  });
  it("names both variables in the missing message, like Telegram's", () => {
    expect(DRIVE_ENV_MISSING).toBe(ENV_COPY.notSet("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET", true));
  });
});

describe("PKCE, state and the consent URL", () => {
  it("makes a verifier of a valid length and its S256 challenge", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(challengeOf(verifier)).toBe(challenge);
    expect(pkcePair().verifier).not.toBe(verifier);
  });
  it("makes an unguessable state and compares it in constant time", () => {
    const s = newState();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sameState(s, s)).toBe(true);
    expect(sameState(s, newState())).toBe(false);
    expect(sameState(s, "")).toBe(false);
    expect(sameState(s, null)).toBe(false);
  });
  it("asks only for drive.file, offline, with the consent screen, PKCE and the fixed callback", () => {
    const url = new URL(authUrl(env, { state: "st", challenge: "ch", redirectUri: redirectUri("https://ops.example.com/") }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: env.clientId, redirect_uri: "https://ops.example.com/auth/google/callback", response_type: "code", scope: DRIVE_SCOPE,
      access_type: "offline", prompt: "consent", state: "st", code_challenge: "ch", code_challenge_method: "S256",
    });
    expect(DRIVE_SCOPE).toBe("https://www.googleapis.com/auth/drive.file");
  });
});

describe("exchangeCode", () => {
  it("posts the code with the verifier and the client secret, and returns the refresh token", async () => {
    const fetch = vi.fn<(u: string, i: RequestInit) => Promise<Response>>(async () => json({ access_token: "at", refresh_token: "fake-refresh-token", scope: DRIVE_SCOPE, token_type: "Bearer" }));
    const r = await exchangeCode(env, { code: "c0de", verifier: "v".repeat(50), redirectUri: "https://x.test/auth/google/callback" }, { fetch: fetch as never });
    expect(r).toEqual({ ok: true, refreshToken: "fake-refresh-token", scope: DRIVE_SCOPE });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(GOOGLE_TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: "authorization_code", code: "c0de", code_verifier: "v".repeat(50), redirect_uri: "https://x.test/auth/google/callback",
      client_id: env.clientId, client_secret: env.clientSecret,
    });
  });
  it("refuses an answer without a refresh token or without drive.file", async () => {
    const noRefresh = vi.fn(async () => json({ access_token: "at", scope: DRIVE_SCOPE }));
    expect(await exchangeCode(env, { code: "c", verifier: "v", redirectUri: "r" }, { fetch: noRefresh as never })).toMatchObject({ ok: false, kind: "format" });
    const otherScope = vi.fn(async () => json({ access_token: "at", refresh_token: "rt", scope: "openid email" }));
    expect(await exchangeCode(env, { code: "c", verifier: "v", redirectUri: "r" }, { fetch: otherScope as never })).toMatchObject({ ok: false, kind: "scope" });
  });
  it("maps Google's OAuth errors without passing their text on", async () => {
    const grant = vi.fn(async () => json({ error: "invalid_grant", error_description: "Bad Request <secret-ish>" }, 400));
    const r = await exchangeCode(env, { code: "c", verifier: "v", redirectUri: "r" }, { fetch: grant as never });
    expect(r).toMatchObject({ ok: false, kind: "revoked" });
    expect(JSON.stringify(r)).not.toContain("secret-ish");
    const client = vi.fn(async () => json({ error: "invalid_client" }, 401));
    expect(await exchangeCode(env, { code: "c", verifier: "v", redirectUri: "r" }, { fetch: client as never })).toMatchObject({ ok: false, kind: "client" });
  });
});

describe("refreshAccessToken", () => {
  it("trades the refresh token for an access token", async () => {
    const fetch = vi.fn<(u: string, i: RequestInit) => Promise<Response>>(async () => json({ access_token: "ya29.fake", expires_in: 3599 }));
    expect(await refreshAccessToken(env, "fake-refresh-token", { fetch: fetch as never })).toEqual({ ok: true, accessToken: "ya29.fake" });
    expect(Object.fromEntries(new URLSearchParams(String(fetch.mock.calls[0][1].body)))).toEqual({
      grant_type: "refresh_token", refresh_token: "fake-refresh-token", client_id: env.clientId, client_secret: env.clientSecret,
    });
  });
  it("says invalid_grant when access was removed or the token expired (CredentialExpiring)", async () => {
    const fetch = vi.fn(async () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400));
    const r = await refreshAccessToken(env, "rt", { fetch: fetch as never });
    expect(r).toEqual({ ok: false, kind: "revoked", error: "invalid_grant: Google Drive access was removed or has expired. Reconnect Google Drive." });
  });
  it("treats an outage, a 429 and a timeout as transient", async () => {
    expect(await refreshAccessToken(env, "rt", { fetch: (async () => json({}, 503)) as never })).toMatchObject({ ok: false, kind: "transient" });
    expect(await refreshAccessToken(env, "rt", { fetch: (async () => json({}, 429)) as never })).toMatchObject({ ok: false, kind: "transient" });
    const timeout = vi.fn(async () => { throw new DOMException("t", "TimeoutError"); });
    expect(await refreshAccessToken(env, "rt", { fetch: timeout as never })).toMatchObject({ ok: false, kind: "transient", error: "Google didn't answer within 10 seconds." });
  });
});
