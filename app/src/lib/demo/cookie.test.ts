import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clearDemoCookie, DEMO_COOKIE, demoCookieKey, demoCookieOptions, newDemoSeed, setDemoCookie, signDemoCookie, verifyDemoCookie } from "./cookie";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 8);
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const SEED = "0123456789abcdef0123456789abcdef";
const visitor = { email: "ana@visitor.test", seed: SEED };

const encode = (body: unknown) => Buffer.from(JSON.stringify(body)).toString("base64url");
const macOf = (payload: string, key = KEY) => createHmac("sha256", key).update(payload).digest("base64url");
// A cookie with this body, signed with `key` (what an attacker who knew the key could make).
const signed = (body: unknown, key = KEY) => `${encode(body)}.${macOf(encode(body), key)}`;
const decode = (cookie: string) => JSON.parse(Buffer.from(cookie.split(".")[0], "base64url").toString("utf8"));

describe("newDemoSeed (ruling F: every sign-in its own dataset)", () => {
  it("is 16 random bytes in hex, different every time and never derived from an email", () => {
    const seeds = Array.from({ length: 20 }, () => newDemoSeed());
    for (const s of seeds) expect(s).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(seeds).size).toBe(seeds.length);
    expect(newDemoSeed.length).toBe(0); // takes no email
  });
});

describe("demoCookieKey", () => {
  it("is HMAC-SHA256(raw OPS_ENCRYPTION_KEY, \"watchpost:demo-cookie:v1\"), never the raw key", () => {
    const raw = Buffer.alloc(32, 7);
    const key = demoCookieKey(raw.toString("base64"));
    expect(key).toEqual(createHmac("sha256", raw).update("watchpost:demo-cookie:v1").digest());
    expect(key.equals(raw)).toBe(false);
    expect(demoCookieKey(Buffer.alloc(32, 8).toString("base64")).equals(key)).toBe(false);
    // A cookie signed with the raw key doesn't verify under the sub-key.
    expect(verifyDemoCookie(signDemoCookie(visitor, raw, NOW), key, NOW)).toBeNull();
  });
});

describe("signDemoCookie / verifyDemoCookie", () => {
  it("round-trips: base64url JSON { email, seed, iat (seconds) } + '.' + HMAC-SHA256", () => {
    const cookie = signDemoCookie(visitor, KEY, NOW);
    expect(decode(cookie)).toEqual({ email: visitor.email, seed: SEED, iat: NOW / 1000 });
    expect(cookie.split(".")[1]).toBe(macOf(cookie.split(".")[0]));
    expect(verifyDemoCookie(cookie, KEY, NOW)).toEqual(visitor);
  });

  it("is signed out when the email, seed or iat is changed but the MAC kept (Review Focus 2)", () => {
    const cookie = signDemoCookie(visitor, KEY, NOW);
    const mac = cookie.split(".")[1];
    const body = decode(cookie);
    for (const changed of [
      { ...body, email: "demo@watchbell.west-solutions.web.id" },
      { ...body, seed: "f".repeat(32) },
      { ...body, iat: body.iat + 60 },
    ]) {
      expect(verifyDemoCookie(`${encode(changed)}.${mac}`, KEY, NOW)).toBeNull();
    }
  });

  it("is signed out with a bad, truncated or missing MAC, or one made with another key", () => {
    const cookie = signDemoCookie(visitor, KEY, NOW);
    const [payload, mac] = cookie.split(".");
    const flipped = (mac[0] === "A" ? "B" : "A") + mac.slice(1);
    for (const value of [`${payload}.${flipped}`, `${payload}.${mac.slice(0, 20)}`, `${payload}.`, payload, `${payload}.${mac}.x`]) {
      expect(verifyDemoCookie(value, KEY, NOW)).toBeNull();
    }
    expect(verifyDemoCookie(cookie, OTHER_KEY, NOW)).toBeNull();
    expect(verifyDemoCookie(signDemoCookie(visitor, OTHER_KEY, NOW), KEY, NOW)).toBeNull();
  });

  it("is signed out once iat is more than 7 days old, and for an iat from the future", () => {
    const cookie = signDemoCookie(visitor, KEY, NOW);
    expect(verifyDemoCookie(cookie, KEY, NOW + 7 * DAY_MS)).toEqual(visitor);
    expect(verifyDemoCookie(cookie, KEY, NOW + 7 * DAY_MS + 1000)).toBeNull();
    expect(verifyDemoCookie(cookie, KEY, NOW - 60 * 60 * 1000)).toBeNull();
  });

  it("is signed out for anything that isn't a well-formed body, even when correctly signed", () => {
    const iat = NOW / 1000;
    for (const body of [
      { email: "Ana@Visitor.test", seed: SEED, iat }, // not lowercased
      { email: "", seed: SEED, iat },
      { email: `${"a".repeat(250)}@x.io`, seed: SEED, iat }, // 255 characters
      { email: visitor.email, seed: "0123", iat },
      { email: visitor.email, seed: SEED.toUpperCase(), iat },
      { email: visitor.email, seed: SEED },
      { email: visitor.email, seed: SEED, iat: String(iat) },
      { email: visitor.email, seed: SEED, iat: iat + 0.5 },
      { seed: SEED, iat },
      null,
      "text",
    ]) {
      expect(verifyDemoCookie(signed(body), KEY, NOW)).toBeNull();
    }
    const notJson = Buffer.from("{nope").toString("base64url");
    expect(verifyDemoCookie(`${notJson}.${macOf(notJson)}`, KEY, NOW)).toBeNull();
    for (const value of [undefined, "", ".", "a b.c", `${"a".repeat(1100)}.b`]) expect(verifyDemoCookie(value, KEY, NOW)).toBeNull();
  });
});

describe("the wp_demo cookie's flags", () => {
  it("httpOnly, sameSite lax, path /, 7 days, secure only when SITE_URL is https; clearing sets max-age 0", () => {
    expect(demoCookieOptions("https://demo.example.com")).toEqual({ httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 604800 });
    expect(demoCookieOptions("http://127.0.0.1:3100")).toMatchObject({ secure: false, maxAge: 604800 });
    const jar = new Map<string, { value: string; options: unknown }>();
    const set = { set: (name: string, value: string, options: unknown) => void jar.set(name, { value, options }) };
    setDemoCookie(set, "v", "https://demo.example.com");
    expect(jar.get(DEMO_COOKIE)).toEqual({ value: "v", options: demoCookieOptions("https://demo.example.com") });
    clearDemoCookie(set, "https://demo.example.com");
    expect(jar.get(DEMO_COOKIE)).toEqual({ value: "", options: { ...demoCookieOptions("https://demo.example.com"), maxAge: 0 } });
  });
});
