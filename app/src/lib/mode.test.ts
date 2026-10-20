import { describe, expect, it } from "vitest";
import { hostedSupabaseDb, isDemo, mode, remoteDbRisk, usesLocalAuth } from "./mode";

describe("mode", () => {
  it("defaults to cloud when unset or empty", () => {
    expect(mode({})).toBe("cloud");
    expect(mode({ WATCHPOST_MODE: "" })).toBe("cloud");
    expect(mode({ WATCHPOST_MODE: "  " })).toBe("cloud");
  });
  it("reads selfhost, demo and cloud, ignoring case and spaces", () => {
    expect(mode({ WATCHPOST_MODE: "selfhost" })).toBe("selfhost");
    expect(mode({ WATCHPOST_MODE: "SELFHOST " })).toBe("selfhost");
    expect(mode({ WATCHPOST_MODE: "demo" })).toBe("demo");
    expect(mode({ WATCHPOST_MODE: "Cloud" })).toBe("cloud");
  });
  it("throws on any other value", () => {
    // The message names the variable the bad value came from.
    expect(() => mode({ WATCHPOST_MODE: "local" })).toThrow("WATCHPOST_MODE must be cloud, selfhost or demo");
    expect(() => mode({ WATCHBELL_MODE: "local" })).toThrow("WATCHBELL_MODE must be cloud, selfhost or demo");
    expect(() => mode({ WATCHBELL_MODE: "local", WATCHPOST_MODE: "selfhost" })).toThrow("WATCHBELL_MODE must be cloud, selfhost or demo");
  });
  it("reads WATCHBELL_MODE first and the old WATCHPOST_MODE as a fallback (existing env files keep working)", () => {
    expect(mode({ WATCHBELL_MODE: "selfhost" })).toBe("selfhost");
    expect(mode({ WATCHBELL_MODE: "demo", WATCHPOST_MODE: "selfhost" })).toBe("demo");
    expect(mode({ WATCHBELL_MODE: "", WATCHPOST_MODE: "selfhost" })).toBe("selfhost");
    expect(usesLocalAuth({ WATCHPOST_MODE: "selfhost" })).toBe(true);
  });
});

describe("hostedSupabaseDb (selfhost must not run its clock against the cloud database)", () => {
  it("is true for a DATABASE_URL on a Supabase host", () => {
    expect(hostedSupabaseDb({ DATABASE_URL: "postgresql://postgres.ref:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres" })).toBe(true);
    expect(hostedSupabaseDb({ DATABASE_URL: "postgres://postgres:pw@db.abcdef.supabase.co:5432/postgres" })).toBe(true);
    expect(hostedSupabaseDb({ DATABASE_URL: " postgres://u:p@DB.ABC.SUPABASE.CO/postgres " })).toBe(true);
  });
  it("is false without one, for other hosts, and for a host that only looks alike", () => {
    expect(hostedSupabaseDb({})).toBe(false);
    expect(hostedSupabaseDb({ DATABASE_URL: "" })).toBe(false);
    expect(hostedSupabaseDb({ DATABASE_URL: "postgres://u:p@localhost:5432/watchpost" })).toBe(false);
    expect(hostedSupabaseDb({ DATABASE_URL: "postgres://u:p@notsupabase.co/x" })).toBe(false);
    expect(hostedSupabaseDb({ DATABASE_URL: "not a url" })).toBe(false);
  });
});

describe("remoteDbRisk (fail closed for URLs we can't vouch for)", () => {
  it("is true for hosted Supabase and for odd non-pglite URLs", () => {
    expect(remoteDbRisk({ DATABASE_URL: "postgres://postgres:pw@db.abcdef.supabase.co:5432/postgres" })).toBe(true);
    expect(remoteDbRisk({ DATABASE_URL: "not a url" })).toBe(true);
    expect(remoteDbRisk({ DATABASE_URL: "postgres:///x" })).toBe(true);
    expect(remoteDbRisk({ DATABASE_URL: "postgres://u:p@a.supabase.co,b.local:5432/x" })).toBe(true);
    expect(remoteDbRisk({ DATABASE_URL: "postgres://u:p@db.local:5432,db2.local:5432/x" })).toBe(true);
  });
  it("is false for unset, pglite and a normal self-managed Postgres", () => {
    expect(remoteDbRisk({})).toBe(false);
    expect(remoteDbRisk({ DATABASE_URL: "" })).toBe(false);
    expect(remoteDbRisk({ DATABASE_URL: "pglite:" })).toBe(false);
    expect(remoteDbRisk({ DATABASE_URL: "pglite:./data/pg" })).toBe(false);
    expect(remoteDbRisk({ DATABASE_URL: "postgres://user:pass@db.local:5432/x" })).toBe(false);
    expect(remoteDbRisk({ DATABASE_URL: "postgres://u:p@localhost:5432/watchpost" })).toBe(false);
  });
});

describe("usesLocalAuth and isDemo", () => {
  it("usesLocalAuth is true for selfhost and demo, false for cloud", () => {
    expect(usesLocalAuth({})).toBe(false);
    expect(usesLocalAuth({ WATCHPOST_MODE: "cloud" })).toBe(false);
    expect(usesLocalAuth({ WATCHPOST_MODE: "selfhost" })).toBe(true);
    expect(usesLocalAuth({ WATCHPOST_MODE: "demo" })).toBe(true);
  });
  it("isDemo is true only for demo", () => {
    expect(isDemo({})).toBe(false);
    expect(isDemo({ WATCHPOST_MODE: "cloud" })).toBe(false);
    expect(isDemo({ WATCHPOST_MODE: "selfhost" })).toBe(false);
    expect(isDemo({ WATCHPOST_MODE: "demo" })).toBe(true);
  });
  it("an unknown mode still throws", () => {
    expect(() => usesLocalAuth({ WATCHPOST_MODE: "local" })).toThrow("WATCHPOST_MODE must be");
    expect(() => isDemo({ WATCHBELL_MODE: "local" })).toThrow("WATCHBELL_MODE must be");
  });
});
