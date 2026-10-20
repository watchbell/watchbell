import { describe, expect, it } from "vitest";
import { accessHint } from "./access";

const ok = { write: "ok" as const, at: "2026-10-13T01:00:00Z" };
const denied = { write: "denied" as const, at: "2026-10-13T01:00:00Z" };

describe("accessHint (A7, the Connections Access line)", () => {
  it("names the actions a working credential allows, per provider (mockup ACCOUNTS[*].actions)", () => {
    expect(accessHint("vercel", ok, null)).toEqual({ tone: "ok", text: "Actions on: redeploy, roll back, promote, cancel" });
    expect(accessHint("supabase", ok, "Reads projects")).toEqual({ tone: "ok", text: "Actions on: pause, restore, keep active" });
    expect(accessHint("neon", ok, null)).toEqual({ tone: "ok", text: "Actions on: wake" });
  });

  it("turns actions off with the A6 replacement hint after a denied write", () => {
    expect(accessHint("supabase", denied, null)).toEqual({ tone: "off", text: "Actions off: replace it with a token that has Project admin write" });
    expect(accessHint("vercel", denied, null)).toEqual({ tone: "off", text: "Actions off: replace it with a token whose scope includes the team" });
    expect(accessHint("neon", denied, null)).toEqual({ tone: "off", text: "Actions off: replace it with a personal or organization key, or a key for this project" });
  });

  it("says not tried yet before any write", () => {
    for (const p of ["vercel", "supabase", "neon"]) expect(accessHint(p, undefined, null)).toEqual({ tone: "faint", text: "Actions: not tried yet" });
    expect(accessHint("vercel", undefined, "Full account (no read-only option)")).toEqual({ tone: "faint", text: "Actions: not tried yet" });
    expect(accessHint("neon", undefined, "All projects (no read-only option)")).toEqual({ tone: "faint", text: "Actions: not tried yet" });
  });

  it("uses a Supabase token's connect-time scope note: read-only is off before any try", () => {
    const off = { tone: "off", text: "Actions off: replace it with a token that has Project admin write" };
    expect(accessHint("supabase", undefined, "Read-only")).toEqual(off);
    expect(accessHint("supabase", undefined, "Scoped token, read only")).toEqual(off);
    expect(accessHint("supabase", undefined, "Reads projects, service health · database size checked daily")).toEqual({ tone: "faint", text: "Actions: not tried yet" });
    // The connect-time check's "missing …" list (test-connection.ts) naming the write permission is off too.
    expect(accessHint("supabase", undefined, "Reads projects · missing analytics_usage_read, project_admin_write · database size checked daily")).toEqual(off);
    expect(accessHint("supabase", undefined, "Reads projects · missing project_admin_read · database size checked daily")).toEqual({ tone: "faint", text: "Actions: not tried yet" });
    expect(accessHint("vercel", undefined, "missing project_admin_write")).toEqual({ tone: "faint", text: "Actions: not tried yet" });
  });

  it("lets the last real write win over the scope note", () => {
    expect(accessHint("supabase", ok, "Read-only")).toEqual({ tone: "ok", text: "Actions on: pause, restore, keep active" });
  });

  it("Cloudflare (slice 2): DNS edit, with the Zone → DNS → Edit hint when it was refused", () => {
    expect(accessHint("cloudflare", ok, null)).toEqual({ tone: "ok", text: "Actions on: DNS edit" });
    expect(accessHint("cloudflare", denied, null)).toEqual({ tone: "off", text: "Actions off: replace it with a token that has Zone → DNS → Edit" });
    expect(accessHint("cloudflare", undefined, "Zone, DNS, SSL and Certificates read")).toEqual({ tone: "faint", text: "Actions: not tried yet" });
  });

  it("shows nothing for providers without actions", () => {
    for (const p of ["firebase", "drive", "other"]) {
      expect(accessHint(p, undefined, null)).toBeNull();
      expect(accessHint(p, ok, "Read-only")).toBeNull();
    }
  });
});
