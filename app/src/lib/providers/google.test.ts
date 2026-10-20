import { createVerify, generateKeyPairSync } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GOOGLE_SCOPES, googleAccessToken, parseServiceAccount, signJwt } from "./google";

const unmatched: string[] = [];
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  server.resetHandlers();
  expect(unmatched.splice(0)).toEqual([]);
});
afterAll(() => server.close());
const catchAll = http.all("*", ({ request }) => {
  unmatched.push(request.url);
  return HttpResponse.error();
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const json = JSON.stringify({ type: "service_account", project_id: "nova-wallet", client_email: "ops@nova-wallet.iam.gserviceaccount.com", private_key: privateKey, private_key_id: "kid1", token_uri: "https://evil.example/token" });
const sa = parseServiceAccount(json)!;
const part = (jwt: string, i: number) => JSON.parse(Buffer.from(jwt.split(".")[i], "base64url").toString());

describe("parseServiceAccount", () => {
  it("accepts a service-account JSON and rejects anything else", () => {
    expect(sa.client_email).toBe("ops@nova-wallet.iam.gserviceaccount.com");
    expect(parseServiceAccount("{}")).toBeNull();
    expect(parseServiceAccount("not json")).toBeNull();
  });
});

describe("signJwt", () => {
  it("signs an RS256 assertion for Google's token endpoint with the read scopes, valid for 1 hour", () => {
    const jwt = signJwt(sa, 1_760_000_000);
    expect(part(jwt, 0)).toEqual({ alg: "RS256", typ: "JWT", kid: "kid1" });
    expect(part(jwt, 1)).toEqual({ iss: sa.client_email, scope: GOOGLE_SCOPES.join(" "), aud: "https://oauth2.googleapis.com/token", iat: 1_760_000_000, exp: 1_760_003_600 });
    const [h, c, s] = jwt.split(".");
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });
});

describe("googleAccessToken", () => {
  it("exchanges the assertion at the fixed Google endpoint, never the JSON's token_uri", async () => {
    let form: URLSearchParams | null = null;
    server.use(http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
      form = new URLSearchParams(await request.text());
      return HttpResponse.json({ access_token: "ya29.fake", expires_in: 3599, token_type: "Bearer" });
    }), catchAll);
    expect(await googleAccessToken(sa, { now: new Date(1_760_000_000_000) })).toEqual({ ok: true, data: "ya29.fake" });
    expect(form!.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(form!.get("assertion")?.split(".")).toHaveLength(3);
  });
  it("calls a deleted or disabled key a rejected credential", async () => {
    server.use(http.post("https://oauth2.googleapis.com/token", () => HttpResponse.json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, { status: 400 })), catchAll);
    expect(await googleAccessToken(sa)).toMatchObject({ ok: false, kind: "auth" });
  });
  it("calls a private key that can't sign a rejected credential, without a network call", async () => {
    expect(await googleAccessToken({ ...sa, private_key: "-----BEGIN PRIVATE " + "KEY-----\nnope\n-----END PRIVATE KEY-----" })).toMatchObject({ ok: false, kind: "auth" });
  });
});
