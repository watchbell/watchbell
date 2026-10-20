import { describe, expect, it } from "vitest";
import { dnsCheck, firebaseCheck, fullName, GCP_QUOTA_HINT, neonCheck, supabaseCheck, validateDns, validateFirebase, validateNeon, validateSupabase } from "./validate";
import { boardItem, cantRemove, summaryOf } from "./types";

describe("DNS record: validation", () => {
  it("turns a short name, @ or a full name into the full name inside the zone", () => {
    expect(fullName("shop", "example.com")).toBe("shop.example.com");
    expect(fullName("Shop.Example.com.", "example.com")).toBe("shop.example.com");
    expect(fullName("@", "example.com")).toBe("example.com");
    expect(fullName("_acme-challenge.www", "example.com")).toBe("_acme-challenge.www.example.com");
    expect(fullName("a..b", "example.com")).toBeNull();
    expect(fullName("bad name", "example.com")).toBeNull();
    expect(fullName("x.*", "example.com")).toBeNull();
  });
  it("accepts A, AAAA, CNAME and TXT with valid content; proxied is off unless asked", () => {
    const r = validateDns({ type: "CNAME", name: "shop", content: "cname.vercel-dns.com." }, "example.com");
    expect(r).toEqual({ ok: true, inputs: { zoneName: "example.com", type: "CNAME", name: "shop.example.com", content: "cname.vercel-dns.com", ttl: 1, proxied: false } });
    expect(validateDns({ type: "A", name: "a", content: "76.76.21.21", ttl: 300 }, "example.com")).toMatchObject({ ok: true, inputs: { ttl: 300 } });
    expect(validateDns({ type: "AAAA", name: "a", content: "2606:4700::1111" }, "example.com").ok).toBe(true);
    expect(validateDns({ type: "TXT", name: "a", content: "v=spf1 -all" }, "example.com").ok).toBe(true);
  });
  it("refuses other types, bad content, a proxied TXT and names outside the rules", () => {
    expect(validateDns({ type: "MX", name: "a", content: "x" }, "example.com")).toMatchObject({ ok: false, field: "type" });
    expect(validateDns({ type: "NS", name: "a", content: "x" }, "example.com")).toMatchObject({ ok: false, field: "type" });
    expect(validateDns({ type: "A", name: "a", content: "999.1.1.1" }, "example.com")).toMatchObject({ ok: false, field: "content" });
    expect(validateDns({ type: "CNAME", name: "a", content: "a.example.com" }, "example.com")).toMatchObject({ ok: false, field: "content" });
    expect(validateDns({ type: "TXT", name: "a", content: "x", proxied: true }, "example.com")).toMatchObject({ ok: false, field: "proxied" });
    expect(validateDns({ type: "A", name: "bad name", content: "1.1.1.1" }, "example.com")).toMatchObject({ ok: false, field: "name" });
    expect(validateDns(null, "example.com")).toMatchObject({ ok: false });
  });
});

describe("DNS record: the live name check", () => {
  const recs = [{ name: "app.example.com", type: "A" }, { name: "www.example.com", type: "CNAME" }];
  it("only a brand-new name passes", () => {
    expect(dnsCheck(recs, { name: "shop.example.com", type: "CNAME" })).toMatchObject({ ok: true });
    expect(dnsCheck(recs, { name: "app.example.com", type: "TXT" })).toMatchObject({ ok: false, error: expect.stringContaining("already exists") });
  });
  it("a CNAME can't share its name with any record, and nothing can join a CNAME", () => {
    expect(dnsCheck(recs, { name: "app.example.com", type: "CNAME" })).toMatchObject({ ok: false, error: expect.stringContaining("can't share") });
    expect(dnsCheck(recs, { name: "www.example.com", type: "TXT" })).toMatchObject({ ok: false, error: expect.stringContaining("CNAME") });
  });
  it("refuses when the record list was cut off (the name can't be proven free)", () => {
    expect(dnsCheck([], { name: "new.example.com", type: "A" }, true)).toMatchObject({ ok: false });
  });
});

describe("Neon branch", () => {
  const branches = Array.from({ length: 3 }, (_, i) => ({ id: `br-aaa-${i}`, name: i === 0 ? "main" : `b${i}` }));
  it("validates the name and the parent id", () => {
    expect(validateNeon({ name: "preview-42", parentId: "br-aaa-0" }, "db")).toEqual({ ok: true, inputs: { projectName: "db", parentId: "br-aaa-0", name: "preview-42" } });
    expect(validateNeon({ name: "Preview", parentId: "br-aaa-0" }, "db")).toMatchObject({ ok: false, field: "name" });
    expect(validateNeon({ name: "-x", parentId: "br-aaa-0" }, "db")).toMatchObject({ ok: false, field: "name" });
    expect(validateNeon({ name: "ok", parentId: "../x" }, "db")).toMatchObject({ ok: false, field: "parentId" });
  });
  it("counts branches against the free limit of 10 and says what it uses", () => {
    expect(neonCheck(branches, { name: "new", parentId: "br-aaa-0" })).toMatchObject({ ok: true, cost: expect.stringContaining("Uses 4 of 10 branches") });
    const ten = Array.from({ length: 10 }, (_, i) => ({ id: `br-aaa-${i}`, name: `b${i}` }));
    expect(neonCheck(ten, { name: "new", parentId: "br-aaa-0" })).toMatchObject({ ok: false, error: expect.stringContaining("10 branches") });
  });
  it("refuses a taken name or a parent that is gone", () => {
    expect(neonCheck(branches, { name: "main", parentId: "br-aaa-0" })).toMatchObject({ ok: false });
    expect(neonCheck(branches, { name: "new", parentId: "br-zzz-9" })).toMatchObject({ ok: false });
  });
});

describe("Supabase project", () => {
  it("validates the org, name and region (from the list)", () => {
    expect(validateSupabase({ orgSlug: "acme", name: "shop db", region: "ap-southeast-1" })).toEqual({ ok: true, inputs: { orgSlug: "acme", name: "shop db", region: "ap-southeast-1" } });
    expect(validateSupabase({ orgSlug: "acme", name: "x", region: "mars-1" })).toMatchObject({ ok: false, field: "region" });
    expect(validateSupabase({ orgSlug: "../a", name: "x", region: "ap-southeast-1" })).toMatchObject({ ok: false, field: "orgSlug" });
    expect(validateSupabase({ orgSlug: "acme", name: "", region: "ap-southeast-1" })).toMatchObject({ ok: false, field: "name" });
  });
  const facts = (o: Partial<Parameters<typeof supabaseCheck>[0]> = {}) => ({ plan: "free", projects: [], paidOrgs: new Set<string>(), ...o });
  it("refuses a paid organization and an unknown plan", () => {
    for (const plan of ["pro", "team", "enterprise", "platform"]) {
      expect(supabaseCheck(facts({ plan }), { orgSlug: "acme", name: "x" })).toMatchObject({ ok: false, error: expect.stringContaining(`${plan} plan`) });
    }
    expect(supabaseCheck(facts({ plan: null }), { orgSlug: "acme", name: "x" })).toMatchObject({ ok: false, error: expect.stringContaining("couldn't read") });
  });
  it("refuses when 2 free projects are already active; paused ones and paid-org ones don't count", () => {
    const a = (orgSlug: string, status: string, name = "p") => ({ orgSlug, status, name });
    expect(supabaseCheck(facts({ projects: [a("acme", "ACTIVE_HEALTHY"), a("other", "COMING_UP")] }), { orgSlug: "acme", name: "x" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("free limit is 2") });
    expect(supabaseCheck(facts({ projects: [a("acme", "ACTIVE_HEALTHY"), a("acme", "INACTIVE"), a("paid", "ACTIVE_HEALTHY")], paidOrgs: new Set(["paid"]) }), { orgSlug: "acme", name: "x" }))
      .toMatchObject({ ok: true, cost: expect.stringContaining("Uses 2 of 2") });
  });
  it("refuses a name already used in that organization", () => {
    expect(supabaseCheck(facts({ projects: [{ orgSlug: "acme", status: "INACTIVE", name: "Shop" }] }), { orgSlug: "acme", name: "shop" })).toMatchObject({ ok: false });
  });
});

describe("Firebase project", () => {
  it("validates the Google Cloud project id and display name", () => {
    expect(validateFirebase({ projectId: "my-app-2026" })).toEqual({ ok: true, inputs: { projectId: "my-app-2026", displayName: "my-app-2026" } });
    for (const projectId of ["short", "1abcdef", "Abcdefg", "abcdef-", "my-google-app", "a".repeat(31)]) {
      expect(validateFirebase({ projectId })).toMatchObject({ ok: false, field: "projectId" });
    }
    expect(validateFirebase({ projectId: "my-app-2026", displayName: "<b>" })).toMatchObject({ ok: false, field: "displayName" });
  });
  it("refuses an id the owner already has and warns at the quota", () => {
    const p = (projectId: string, state = "ACTIVE") => ({ projectId, state });
    expect(firebaseCheck([p("my-app-2026")], { projectId: "my-app-2026" })).toMatchObject({ ok: false });
    expect(firebaseCheck(Array.from({ length: GCP_QUOTA_HINT }, (_, i) => p(`p-${i}xxxxx`)), { projectId: "new-app-01" })).toMatchObject({ ok: false, error: expect.stringContaining("quota") });
    expect(firebaseCheck([p("a-deleted-1", "DELETE_REQUESTED")], { projectId: "new-app-01" })).toMatchObject({ ok: true, cost: expect.stringContaining("no billing account") });
  });
});

describe("types", () => {
  it("summaries name what will be created, and the approval sentence names the provider", () => {
    expect(summaryOf("neon_branch", { projectName: "db", parentId: "br-a", parentName: "main", name: "p1" })).toEqual({ summary: "Branch p1 from main in db, no compute", confirmName: "p1" });
    expect(cantRemove("supabase_project")).toBe("The console can't remove this later; remove it in Supabase's dashboard.");
  });
  it("the office board item carries no names, only a console link", () => {
    const b = boardItem({ id: "123e4567-e89b-42d3-a456-426614174000", type: "dns_record", createdAt: "x", expiresAt: "y" });
    expect(b).toEqual({ id: "123e4567-e89b-42d3-a456-426614174000", title: "Create DNS record on Cloudflare", url: "/dns?create=123e4567-e89b-42d3-a456-426614174000", createdAt: "x", expiresAt: "y" });
  });
});
