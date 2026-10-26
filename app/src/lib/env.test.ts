import { describe, expect, it, vi } from "vitest";
import { parseServerEnv } from "./env";

const valid = {
  NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_aaaaaaaaaaaaaaaaaaaa",
  SUPABASE_SECRET_KEY: "sb_secret" + "_aaaaaaaaaaaaaaaaaaaaaaaa",
  DATABASE_URL: "postgresql://postgres.ref:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres",
  OPS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  OWNER_EMAIL: "owner@example.com",
  SITE_URL: "http://localhost:3100",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0xEXAMPLEsitekey000000",
};

describe("parseServerEnv", () => {
  it("accepts a complete environment", () => {
    expect(parseServerEnv(valid).OWNER_EMAIL).toBe("owner@example.com");
  });

  it("names the missing keys without echoing any value", () => {
    const run = () => parseServerEnv({ ...valid, SUPABASE_SECRET_KEY: undefined, DATABASE_URL: "mysql://secret-value" });
    expect(run).toThrow(/SUPABASE_SECRET_KEY, DATABASE_URL/);
    expect(run).not.toThrow(/secret-value/);
  });

  it("rejects an encryption key that isn't 32 bytes", () => {
    expect(() => parseServerEnv({ ...valid, OPS_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") })).toThrow(/OPS_ENCRYPTION_KEY/);
  });

  describe("selfhost and demo modes", () => {
    const minimal = { WATCHPOST_MODE: "selfhost", OPS_ENCRYPTION_KEY: valid.OPS_ENCRYPTION_KEY, SITE_URL: "http://localhost:3000" };

    it("needs only the encryption key and site URL, and defaults the rest to empty", () => {
      const env = parseServerEnv(minimal);
      expect(env.DATABASE_URL).toBe("");
      expect(env.SUPABASE_SECRET_KEY).toBe("");
      expect(env.OWNER_EMAIL).toBe("");
      expect(parseServerEnv({ ...minimal, WATCHPOST_MODE: "demo" }).DATABASE_URL).toBe("");
    });
    it("is cloud (and fails) without WATCHPOST_MODE", () => {
      expect(() => parseServerEnv({ ...minimal, WATCHPOST_MODE: undefined })).toThrow(/Missing or invalid/);
    });
    it("still requires the encryption key and site URL", () => {
      expect(() => parseServerEnv({ ...minimal, OPS_ENCRYPTION_KEY: undefined })).toThrow(/OPS_ENCRYPTION_KEY/);
      expect(() => parseServerEnv({ ...minimal, SITE_URL: undefined })).toThrow(/SITE_URL/);
    });
    it("accepts the pglite: sentinel in selfhost and demo, but not in cloud", () => {
      expect(parseServerEnv({ ...minimal, DATABASE_URL: "pglite:" }).DATABASE_URL).toBe("pglite:");
      expect(parseServerEnv({ ...minimal, WATCHPOST_MODE: "demo", DATABASE_URL: "pglite:" }).DATABASE_URL).toBe("pglite:");
      expect(() => parseServerEnv({ ...valid, DATABASE_URL: "pglite:" })).toThrow(/DATABASE_URL/);
    });

    it("validates DATABASE_URL only when present", () => {
      expect(() => parseServerEnv({ ...minimal, DATABASE_URL: "mysql://x" })).toThrow(/DATABASE_URL/);
      expect(parseServerEnv({ ...minimal, DATABASE_URL: valid.DATABASE_URL }).DATABASE_URL).toBe(valid.DATABASE_URL);
    });

    // 1.2.2 release smoke: a self-hosted install on its own machine runs at localhost, so a production build there must
    // not print "SITE_URL points at localhost" on every start; the cloud edition still warns.
    it("warns about a localhost SITE_URL only in the cloud edition", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        parseServerEnv({ ...minimal, NODE_ENV: "production" });
        parseServerEnv({ ...minimal, WATCHPOST_MODE: "demo", NODE_ENV: "production" });
        expect(warn).not.toHaveBeenCalled();
        parseServerEnv({ ...valid, NODE_ENV: "production" });
        expect(warn).toHaveBeenCalledWith("env: SITE_URL points at localhost");
      } finally {
        warn.mockRestore();
      }
    });
  });
});
