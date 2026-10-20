import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { discoverNeon, getEndpoint, getNeonProject, listBranches, listEndpoints, listNeonProjects, startEndpoint } from "./neon";

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
const API = "https://console.neon.tech/api/v2";
const K = "napi_fake_key_for_tests_0000000000000";
const item = (id: string, name: string) => ({ id, name, region_id: "aws-ap-southeast-1", pg_version: 17, created_at: "2026-10-09T00:00:00Z", org_id: "org-1" });

describe("listNeonProjects", () => {
  it("passes org_id and follows the cursor while pages are full", async () => {
    const seen: string[] = [];
    server.use(http.get(`${API}/projects`, ({ request }) => {
      const u = new URL(request.url);
      seen.push(`${u.searchParams.get("org_id")}:${u.searchParams.get("cursor") ?? "-"}`);
      if (!u.searchParams.get("cursor")) return HttpResponse.json({ projects: Array.from({ length: 100 }, (_, i) => item(`p${i}`, `n${i}`)), pagination: { cursor: "p99" } });
      return HttpResponse.json({ projects: [item("p100", "last")], pagination: { cursor: "p100" } });
    }), catchAll);
    const r = await listNeonProjects(K, "org-1");
    expect(seen).toEqual(["org-1:-", "org-1:p99"]);
    expect(r.ok && r.data.length).toBe(101);
  });
});

describe("discoverNeon", () => {
  it("lists projects per organization of a personal key", async () => {
    server.use(
      http.get(`${API}/users/me/organizations`, () => HttpResponse.json({ organizations: [{ id: "org-1", name: "Acme" }] })),
      http.get(`${API}/projects`, () => HttpResponse.json({ projects: [item("ticketer-id", "ticketer")] })),
      catchAll,
    );
    const r = await discoverNeon(K);
    expect(r.ok && r.data.map((p) => [p.id, p.name, p.orgId])).toEqual([["ticketer-id", "ticketer", "org-1"]]);
  });
  it("falls back to a plain project list when the key isn't tied to a user (project-scoped key)", async () => {
    server.use(
      http.get(`${API}/users/me/organizations`, () => HttpResponse.json({ message: "not found" }, { status: 404 })),
      http.get(`${API}/projects`, ({ request }) => HttpResponse.json({ projects: new URL(request.url).searchParams.has("org_id") ? [] : [item("x", "only")] })),
      catchAll,
    );
    const r = await discoverNeon(K);
    expect(r.ok && r.data.map((p) => p.id)).toEqual(["x"]);
  });
  it("fails on a rejected key instead of returning nothing (an empty list would mark every project gone)", async () => {
    server.use(http.get(`${API}/users/me/organizations`, () => HttpResponse.json({}, { status: 401 })), catchAll);
    expect(await discoverNeon(K)).toMatchObject({ ok: false, kind: "auth" });
  });
});

describe("getNeonProject", () => {
  it("reads this period's compute seconds, transfer and period end", async () => {
    server.use(http.get(`${API}/projects/ticketer-id`, () => HttpResponse.json({ project: {
      id: "ticketer-id", name: "ticketer", region_id: "aws-ap-southeast-1", pg_version: 17, compute_time_seconds: 148_320, active_time_seconds: 593_280,
      data_transfer_bytes: 1_932_735_283, written_data_bytes: 1, consumption_period_start: "2026-10-01T00:00:00Z", consumption_period_end: "2026-11-01T00:00:00Z",
      compute_last_active_at: "2026-10-12T11:02:00Z",
    } })), catchAll);
    expect(await getNeonProject(K, "ticketer-id")).toEqual({ ok: true, data: {
      computeSeconds: 148_320, transferBytes: 1_932_735_283, periodStart: "2026-10-01T00:00:00Z", periodEnd: "2026-11-01T00:00:00Z",
      region: "aws-ap-southeast-1", pgVersion: 17, lastActive: "2026-10-12T11:02:00Z", activeSeconds: 593_280,
    } });
  });
});

describe("listEndpoints / listBranches", () => {
  it("maps computes and branches", async () => {
    server.use(
      http.get(`${API}/projects/p/endpoints`, () => HttpResponse.json({ endpoints: [{ id: "ep-quiet-sun-a1b2c3", branch_id: "br-main", current_state: "idle", disabled: false, autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 2, last_active: "2026-10-12T11:02:00Z", type: "read_write" }] })),
      http.get(`${API}/projects/p/branches`, () => HttpResponse.json({ branches: [{ id: "br-main", name: "main", default: true, logical_size: 56_623_104 }, { id: "br-dev", name: "dev", primary: false }] })),
      catchAll,
    );
    expect(await listEndpoints(K, "p")).toEqual({ ok: true, data: [{ id: "ep-quiet-sun-a1b2c3", branchId: "br-main", state: "idle", pendingState: null, disabled: false, minCu: 0.25, maxCu: 2, lastActive: "2026-10-12T11:02:00Z" }] });
    expect(await listBranches(K, "p")).toEqual({ ok: true, data: [{ id: "br-main", name: "main", isDefault: true, logicalSize: 56_623_104 }, { id: "br-dev", name: "dev", isDefault: false, logicalSize: null }] });
  });
});

const EP = "ep-quiet-sun-a1b2c3";
const endpoint = (extra: Record<string, unknown> = {}) => ({
  id: EP, branch_id: "br-main", current_state: "idle", disabled: false, autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 2, last_active: "2026-10-12T11:02:00Z", ...extra,
});

describe("getEndpoint", () => {
  it("reads one compute of the project", async () => {
    server.use(http.get(`${API}/projects/p/endpoints/${EP}`, () => HttpResponse.json({ endpoint: endpoint({ pending_state: "active" }) })), catchAll);
    expect(await getEndpoint(K, "p", EP)).toEqual({ ok: true, data: {
      id: EP, branchId: "br-main", state: "idle", pendingState: "active", disabled: false, minCu: 0.25, maxCu: 2, lastActive: "2026-10-12T11:02:00Z",
    } });
  });
  it("answers missing when the compute isn't in that project", async () => {
    server.use(http.get(`${API}/projects/p/endpoints/${EP}`, () => HttpResponse.json({ message: "not found" }, { status: 404 })), catchAll);
    expect(await getEndpoint(K, "p", EP)).toMatchObject({ ok: false, kind: "missing" });
  });
});

describe("startEndpoint (Wake)", () => {
  it("sends one POST to …/endpoints/{id}/start with no body", async () => {
    const seen: { method: string; path: string; body: string; type: string | null }[] = [];
    server.use(http.post(`${API}/projects/p/endpoints/${EP}/start`, async ({ request }) => {
      seen.push({ method: request.method, path: new URL(request.url).pathname, body: await request.text(), type: request.headers.get("content-type") });
      return HttpResponse.json({ endpoint: endpoint({ current_state: "init" }), operations: [] });
    }), catchAll);
    expect(await startEndpoint(K, "p", EP)).toEqual({ ok: true, data: null });
    expect(seen).toEqual([{ method: "POST", path: `/api/v2/projects/p/endpoints/${EP}/start`, body: "", type: null }]);
  });
  it("maps 423 (another operation is running) to busy", async () => {
    server.use(http.post(`${API}/projects/p/endpoints/${EP}/start`, () => HttpResponse.json({ message: "project already has running operations" }, { status: 423 })), catchAll);
    expect(await startEndpoint(K, "p", EP)).toEqual({ ok: false, kind: "busy", status: 423, error: "Neon is busy with another operation. Try again in a minute." });
  });
  it("maps 403 to scope, without the provider's body", async () => {
    server.use(http.post(`${API}/projects/p/endpoints/${EP}/start`, () => HttpResponse.json({ message: "secret-ish body" }, { status: 403 })), catchAll);
    const r = await startEndpoint(K, "p", EP);
    expect(r).toMatchObject({ ok: false, kind: "scope", status: 403 });
    expect(JSON.stringify(r)).not.toContain("secret-ish");
  });
  it("keeps 401 as a rejected credential", async () => {
    server.use(http.post(`${API}/projects/p/endpoints/${EP}/start`, () => HttpResponse.json({}, { status: 401 })), catchAll);
    expect(await startEndpoint(K, "p", EP)).toMatchObject({ ok: false, kind: "auth", error: "Neon rejected this credential (401)." });
  });
});

// Review focus 1 / A1: the only write this adapter can produce is the start call (Neon's other compute calls suspend
// or remove things). Every request the write functions send is recorded and compared with that one entry.
describe("Neon write paths", () => {
  it("are exactly POST …/endpoints/{id}/start", async () => {
    const calls: string[] = [];
    server.use(http.all("*", ({ request }) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ endpoint: endpoint(), operations: [] });
    }));
    await startEndpoint(K, "p", EP);
    await startEndpoint(K, "proj with/slash", "ep-x-y-z");
    expect(calls).toEqual([`POST /api/v2/projects/p/endpoints/${EP}/start`, "POST /api/v2/projects/proj%20with%2Fslash/endpoints/ep-x-y-z/start"]);
  });
});
