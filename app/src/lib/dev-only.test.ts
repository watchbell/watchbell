import { describe, expect, it } from "vitest";
import { DEV_ONLY_COPY } from "@/lib/copy/edition";
import { devOnlyProblems, isDevRuntime, isLocalHost, isLocalUrl, isTurnstileTestKey } from "./dev-only";
import { parseServerEnv } from "./env";
import { normalizeCredential } from "./providers/normalize";

// Stage 8 cleanup: localhost and test-only allowances apply only when NODE_ENV !== "production".
const PROD = { NODE_ENV: "production" };
const DEV = { NODE_ENV: "development" };

describe("dev-only gate", () => {
  it("knows development from production", () => {
    expect(isDevRuntime(DEV)).toBe(true);
    expect(isDevRuntime({ NODE_ENV: "test" })).toBe(true);
    expect(isDevRuntime(PROD)).toBe(false);
  });
  it("recognises local hosts and Cloudflare's Turnstile test keys", () => {
    expect(["localhost", "localhost:3100", "127.0.0.1", "[::1]:3000"].every(isLocalHost)).toBe(true);
    expect(isLocalHost("ops.example.com")).toBe(false);
    expect(isLocalUrl("http://localhost:3100")).toBe(true);
    expect(isLocalUrl("https://ops.example.com")).toBe(false);
    for (const k of ["1x00000000000000000000AA", "2x00000000000000000000AB", "1x00000000000000000000BB", "3x00000000000000000000FF"]) expect(isTurnstileTestKey(k)).toBe(true);
    expect(isTurnstileTestKey("0xEXAMPLEsitekey000000")).toBe(false);
  });
  it("lists what production must not carry, names only", () => {
    const env = { ...PROD, NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA", SITE_URL: "http://localhost:3100", OFFICE_LOCAL_CLAUDE_URL: "http://127.0.0.1:4321" };
    expect(devOnlyProblems(env)).toEqual([
      "NEXT_PUBLIC_TURNSTILE_SITE_KEY is a Cloudflare test key", "SITE_URL points at localhost",
      // The edition's own dev-only variables (the private edition: OFFICE_LOCAL_CLAUDE_URL; none in the open source one).
      ...DEV_ONLY_COPY.env.filter((n) => n in env).map((n) => `${n} is set (ignored in production)`),
    ]);
    expect(devOnlyProblems({ ...env, NODE_ENV: "development" })).toEqual([]);
  });
});

describe("the allowances, gated", () => {
  const valid = {
    NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_aaaaaaaaaaaaaaaaaaaa",
    SUPABASE_SECRET_KEY: "sb_secret" + "_aaaaaaaaaaaaaaaaaaaaaaaa", DATABASE_URL: "postgresql://u:p@db.example.com:6543/postgres",
    OPS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"), OWNER_EMAIL: "owner@example.com", SITE_URL: "https://ops.example.com",
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  };
  it("a Turnstile test key works in development and is refused in production", () => {
    expect(parseServerEnv({ ...valid, NODE_ENV: "development" }).NEXT_PUBLIC_TURNSTILE_SITE_KEY).toBe("1x00000000000000000000AA");
    expect(() => parseServerEnv({ ...valid, NODE_ENV: "production" })).toThrow(/NEXT_PUBLIC_TURNSTILE_SITE_KEY/);
    expect(parseServerEnv({ ...valid, NODE_ENV: "production", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0xEXAMPLEsitekey000000" }).SITE_URL).toBe("https://ops.example.com");
  });
});

describe("Upstash credential", () => {
  it("is pasted as email:API_KEY", () => {
    expect(normalizeCredential("upstash", "  owner@example.com:0123456789abcdef0123456789abcdef ")).toEqual({ ok: true, value: "owner@example.com:0123456789abcdef0123456789abcdef" });
    expect(normalizeCredential("upstash", "0123456789abcdef0123456789abcdef0123")).toEqual({ ok: false, error: "Paste your Upstash email and the API key as email:API_KEY." });
  });
});
