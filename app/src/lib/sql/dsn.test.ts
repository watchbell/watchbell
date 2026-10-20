import { describe, expect, it } from "vitest";
import { parseDsn } from "./dsn";

const REF = "abcdefghijklmnopqrst";
const SUPA = `postgresql://watchpost_ro.${REF}:fake%40pass@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`;
const NEON = "postgresql://watchpost_ro:fakepass@ep-quiet-dawn-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

describe("parseDsn", () => {
  it("reads a Supabase pooler string and checks its project", () => {
    expect(parseDsn(SUPA, "supabase", REF)).toEqual({
      ok: true, role: "watchpost_ro", endpointId: null,
      dsn: { host: "aws-0-ap-southeast-1.pooler.supabase.com", port: 6543, user: `watchpost_ro.${REF}`, password: "fake@pass", database: "postgres" },
    });
    expect(parseDsn(SUPA, "supabase", "tsrqponmlkjihgfedcba")).toMatchObject({ ok: false, error: expect.stringContaining("different Supabase project") });
  });

  it("refuses the direct Supabase host, the postgres role and a user without the ref", () => {
    expect(parseDsn(`postgresql://postgres:x@db.${REF}.supabase.co:5432/postgres`, "supabase", REF)).toMatchObject({ ok: false, error: expect.stringContaining("pooler") });
    expect(parseDsn(`postgresql://postgres.${REF}:x@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`, "supabase", REF)).toMatchObject({ ok: false, error: expect.stringContaining("postgres role") });
    expect(parseDsn("postgresql://watchpost_ro:x@aws-0-eu-central-1.pooler.supabase.com:6543/postgres", "supabase", REF)).toMatchObject({ ok: false });
  });

  it("reads a Neon string, keeps the endpoint id and ignores its query parameters", () => {
    expect(parseDsn(NEON, "neon")).toEqual({
      ok: true, role: "watchpost_ro", endpointId: "ep-quiet-dawn-123456",
      dsn: { host: "ep-quiet-dawn-123456-pooler.us-east-2.aws.neon.tech", port: 5432, user: "watchpost_ro", password: "fakepass", database: "neondb" },
    });
    expect(parseDsn(NEON.replace("-pooler", ""), "neon")).toMatchObject({ ok: true, endpointId: "ep-quiet-dawn-123456" });
  });

  it("refuses the Neon owner role and a non-Neon host", () => {
    expect(parseDsn(NEON.replace("watchpost_ro", "neondb_owner"), "neon")).toMatchObject({ ok: false, error: expect.stringContaining("owns the database") });
    expect(parseDsn("postgresql://ro:x@db.example.com/app", "neon")).toMatchObject({ ok: false });
  });

  it("refuses junk without repeating it", () => {
    for (const raw of ["", "   ", "not a url", "mysql://u:p@h/db", "postgresql://h/db", 42, null, `postgresql://u:p@h/${"x".repeat(1000)}`, "postgresql://u:p@h:99999/db"]) {
      const r = parseDsn(raw, "neon");
      expect(r.ok).toBe(false);
      if (!r.ok && typeof raw === "string" && raw.length > 3) expect(r.error).not.toContain(raw);
    }
    const r = parseDsn("postgresql://watchpost_ro:SuperSecret@ep-x-1.us-east-2.aws.neon.tech:0/db", "supabase", REF);
    expect(JSON.stringify(r)).not.toContain("SuperSecret");
  });
});
