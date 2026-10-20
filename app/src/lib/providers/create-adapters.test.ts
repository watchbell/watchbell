import { describe, expect, it } from "vitest";
import * as cfCreate from "./cloudflare-create";
import * as gcp from "./gcp-create";
import * as neonCreate from "./neon-create";
import * as supaCreate from "./supabase-create";

// Stage 6 create requests: every create adapter is pinned to its ONE create endpoint (spec §5, like slice 2's "only GET
// and PATCH" test). No PUT, PATCH, DELETE, batch or import endpoint is ever called. All network is a fake fetch.

type Call = { method: string; url: string; body: unknown; auth: string | null };
function fake(answer: (c: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const c = { method: init.method ?? "GET", url, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body ?? null, auth: headers.get("authorization") };
    calls.push(c);
    const a = answer(c);
    return new Response(a.json === undefined ? null : JSON.stringify(a.json), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, f };
}

describe("module surface", () => {
  it("exports only the reads and the one create each", () => {
    expect(Object.keys(cfCreate).filter((k) => typeof (cfCreate as Record<string, unknown>)[k] === "function")).toEqual(["createDnsRecord"]);
    expect(Object.keys(neonCreate).filter((k) => typeof (neonCreate as Record<string, unknown>)[k] === "function")).toEqual(["createBranch"]);
    expect(Object.keys(supaCreate).filter((k) => typeof (supaCreate as Record<string, unknown>)[k] === "function").sort()).toEqual(["createProject", "listOrganizations"]);
    expect(Object.keys(gcp).filter((k) => typeof (gcp as Record<string, unknown>)[k] === "function").sort()).toEqual(["addFirebase", "createGcpProject", "getOperation", "listGcpProjects"]);
  });
});

describe("Cloudflare: createDnsRecord", () => {
  const rec = { id: "r1", type: "CNAME", name: "shop.example.com", content: "cname.vercel-dns.com", proxied: false, ttl: 1 };
  it("makes exactly one POST /zones/{zone}/dns_records, proxied off unless asked", async () => {
    const { calls, f } = fake(() => ({ json: { success: true, result: rec } }));
    const r = await cfCreate.createDnsRecord("cf_tok", "z".repeat(32), { type: "CNAME", name: "shop.example.com", content: "cname.vercel-dns.com", ttl: 1 }, { fetch: f });
    expect(r).toMatchObject({ ok: true, data: { id: "r1", name: "shop.example.com" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: `https://api.cloudflare.com/client/v4/zones/${"z".repeat(32)}/dns_records`, auth: "Bearer cf_tok" });
    expect(calls[0].body).toEqual({ type: "CNAME", name: "shop.example.com", content: "cname.vercel-dns.com", ttl: 1, proxied: false, comment: "Added from Watchbell" });
  });
  it("never sends proxied with TXT; a 403 names DNS Edit; a refusal passes only the numeric code", async () => {
    const { calls, f } = fake(() => ({ status: 403 }));
    expect(await cfCreate.createDnsRecord("t", "z1", { type: "TXT", name: "a.example.com", content: "x", ttl: 1, proxied: true }, { fetch: f }))
      .toMatchObject({ ok: false, kind: "scope", error: expect.stringContaining("Zone → DNS → Edit") });
    expect(calls[0].body).not.toHaveProperty("proxied");
    const { f: f2 } = fake(() => ({ status: 400, json: { success: false, errors: [{ code: 81053, message: "An A, AAAA, or CNAME record with that host already exists. secret-ish text" }] } }));
    const r = await cfCreate.createDnsRecord("t", "z1", { type: "A", name: "a.example.com", content: "1.1.1.1", ttl: 1 }, { fetch: f2 });
    expect(r).toMatchObject({ ok: false, kind: "refused", error: "Cloudflare refused this record (400, code 81053)." });
  });
});

describe("Neon: createBranch", () => {
  it("one POST /projects/{id}/branches with endpoints: [] (no compute)", async () => {
    const { calls, f } = fake(() => ({ status: 201, json: { branch: { id: "br-new-1", name: "p1" }, endpoints: [], operations: [] } }));
    expect(await neonCreate.createBranch("neon_tok", "proj-1", { name: "p1", parentId: "br-main-1" }, { fetch: f })).toEqual({ ok: true, data: { id: "br-new-1", name: "p1" } });
    expect(calls).toEqual([{ method: "POST", url: "https://console.neon.tech/api/v2/projects/proj-1/branches", auth: "Bearer neon_tok", body: { branch: { name: "p1", parent_id: "br-main-1" }, endpoints: [] } }]);
  });
  it("423 is busy, 422 a refusal (the branch limit)", async () => {
    expect(await neonCreate.createBranch("t", "p", { name: "a", parentId: "br-a" }, { fetch: fake(() => ({ status: 423 })).f })).toMatchObject({ ok: false, kind: "busy" });
    expect(await neonCreate.createBranch("t", "p", { name: "a", parentId: "br-a" }, { fetch: fake(() => ({ status: 422, json: { message: "limit" } })).f })).toMatchObject({ ok: false, kind: "format", status: 422 });
  });
});

describe("Supabase: listOrganizations and createProject", () => {
  it("reads the organizations with one GET", async () => {
    const { calls, f } = fake(() => ({ json: [{ id: "old", slug: "acme", name: "Acme" }] }));
    expect(await supaCreate.listOrganizations("sbp_t", { fetch: f })).toEqual({ ok: true, data: [{ slug: "acme", name: "Acme" }] });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://api.supabase.com/v1/organizations"]);
  });
  it("one POST /v1/projects: org slug, a specific region, the password, no instance size or plan", async () => {
    const { calls, f } = fake(() => ({ status: 201, json: { id: "abcd", ref: "abcd", name: "shop", status: "COMING_UP", region: "ap-southeast-1", organization_slug: "acme", created_at: "x" } }));
    const r = await supaCreate.createProject("sbp_t", { orgSlug: "acme", name: "shop", region: "ap-southeast-1", dbPass: "Pw123" }, { fetch: f });
    expect(r).toEqual({ ok: true, data: { ref: "abcd", name: "shop", status: "COMING_UP", region: "ap-southeast-1" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://api.supabase.com/v1/projects" });
    expect(calls[0].body).toEqual({ name: "shop", organization_slug: "acme", region_selection: { type: "specific", code: "ap-southeast-1" }, db_pass: "Pw123" });
    expect(JSON.stringify(r)).not.toContain("Pw123");
  });
  it("a 403 says which permission to add, and Supabase's own message is never passed on", async () => {
    const { f } = fake(() => ({ status: 403, json: { message: "nope Pw123" } }));
    const r = await supaCreate.createProject("t", { orgSlug: "acme", name: "shop", region: "ap-southeast-1", dbPass: "Pw123" }, { fetch: f });
    expect(r).toMatchObject({ ok: false, kind: "scope", error: expect.stringContaining("organization_projects_create") });
    expect(JSON.stringify(r)).not.toContain("Pw123");
  });
});

describe("Google: createGcpProject + addFirebase", () => {
  it("projects.create is one POST /v3/projects with id and name only (no parent, no billing)", async () => {
    const { calls, f } = fake(() => ({ json: { name: "operations/cp.123", done: false } }));
    expect(await gcp.createGcpProject("ya29", { projectId: "my-app-2026", displayName: "My app" }, { fetch: f })).toEqual({ ok: true, data: { name: "operations/cp.123", done: false, error: null } });
    expect(calls).toEqual([{ method: "POST", url: "https://cloudresourcemanager.googleapis.com/v3/projects", auth: "Bearer ya29", body: { projectId: "my-app-2026", displayName: "My app" } }]);
  });
  it("addFirebase is one POST /v1beta1/projects/{id}:addFirebase", async () => {
    const { calls, f } = fake(() => ({ json: { name: "operations/workflows/abc", done: false } }));
    expect(await gcp.addFirebase("ya29", "my-app-2026", { fetch: f })).toMatchObject({ ok: true });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST https://firebase.googleapis.com/v1beta1/projects/my-app-2026:addFirebase"]);
  });
  it("operation reads are GETs, and a crafted operation name never reaches a URL", async () => {
    const { calls, f } = fake(() => ({ json: { name: "operations/cp.123", done: true } }));
    expect(await gcp.getOperation("t", "crm", "operations/cp.123", { fetch: f })).toMatchObject({ ok: true, data: { done: true } });
    expect(await gcp.getOperation("t", "crm", "operations/../projects/x", { fetch: f })).toMatchObject({ ok: false, kind: "format" });
    expect(await gcp.getOperation("t", "firebase", "projects/x", { fetch: f })).toMatchObject({ ok: false });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://cloudresourcemanager.googleapis.com/v3/operations/cp.123"]);
  });
  it("the project list is read with GET projects:search, page by page", async () => {
    let n = 0;
    const { calls, f } = fake(() => ({ json: n++ === 0 ? { projects: [{ projectId: "a-1xxxx", state: "ACTIVE" }], nextPageToken: "p2" } : { projects: [{ projectId: "b-1xxxx", state: "DELETE_REQUESTED" }] } }));
    expect(await gcp.listGcpProjects("t", { fetch: f })).toMatchObject({ ok: true, data: [{ projectId: "a-1xxxx" }, { projectId: "b-1xxxx", state: "DELETE_REQUESTED" }] });
    expect(calls.every((c) => c.method === "GET" && c.url.startsWith("https://cloudresourcemanager.googleapis.com/v3/projects:search?"))).toBe(true);
  });
});
