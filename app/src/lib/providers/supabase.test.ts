import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { apiCounts, databaseSize, getProject, KEEP_ALIVE_QUERY, keepAlive, listProjects, orgPlan, pauseProject, restoreProject, serviceHealth, SIZE_QUERY, supabaseScopeCheck } from "./supabase";

const unmatched: string[] = [];
const seen: string[] = [];
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  server.resetHandlers();
  seen.length = 0;
  expect(unmatched.splice(0)).toEqual([]);
});
afterAll(() => server.close());
const catchAll = http.all("*", ({ request }) => {
  unmatched.push(request.url);
  return HttpResponse.error();
});
const API = "https://api.supabase.com";
const T = "sbp_fake_token_for_tests_000000000000";
const REF = "abcdefghijklmnopqrst";

describe("listProjects", () => {
  it("maps the Management API project list", async () => {
    server.use(http.get(`${API}/v1/projects`, () => HttpResponse.json([
      { id: REF, ref: REF, organization_id: "o", organization_slug: "org-a", name: "portfolio", region: "ap-southeast-1", created_at: "2026-03-14T00:00:00Z", status: "ACTIVE_HEALTHY", database: { host: "db", version: "17.4.1", postgres_engine: "17", release_channel: "ga" } },
      { id: "x", ref: "zyxwvutsrqponmlkjihg", organization_id: "o", organization_slug: "org-a", name: "quillpad", region: "ap-southeast-1", created_at: "2026-07-27T00:00:00Z", status: "INACTIVE", database: { host: "db", version: "15.8.1", postgres_engine: "15", release_channel: "ga" } },
    ])), catchAll);
    const r = await listProjects(T);
    expect(r.ok && r.data.map((p) => [p.ref, p.name, p.orgSlug, p.status, p.pgVersion])).toEqual([
      [REF, "portfolio", "org-a", "ACTIVE_HEALTHY", "17.4.1"], ["zyxwvutsrqponmlkjihg", "quillpad", "org-a", "INACTIVE", "15.8.1"],
    ]);
  });
  it("is a format failure when the answer is not a project list", async () => {
    server.use(http.get(`${API}/v1/projects`, () => HttpResponse.json({ nope: true })), catchAll);
    expect(await listProjects(T)).toMatchObject({ ok: false, kind: "format" });
  });
});

describe("orgPlan", () => {
  it("returns the plan, or null when the field is absent", async () => {
    server.use(http.get(`${API}/v1/organizations/org-a`, () => HttpResponse.json({ id: "o", name: "A", plan: "free", opt_in_tags: [], allowed_release_channels: ["ga"] })), catchAll);
    expect(await orgPlan(T, "org-a")).toEqual({ ok: true, data: "free" });
    server.use(http.get(`${API}/v1/organizations/org-b`, () => HttpResponse.json({ id: "o", name: "B", opt_in_tags: [], allowed_release_channels: [] })), catchAll);
    expect(await orgPlan(T, "org-b")).toEqual({ ok: true, data: null });
  });
});

describe("serviceHealth", () => {
  it("asks for the five services, one services= each, and no timeout_ms (the API rejects it)", async () => {
    server.use(http.get(`${API}/v1/projects/${REF}/health`, ({ request }) => {
      seen.push(new URL(request.url).search);
      return HttpResponse.json([{ name: "db", healthy: true, status: "ACTIVE_HEALTHY" }, { name: "auth", healthy: false, status: "UNHEALTHY", error: "timeout" }]);
    }), catchAll);
    const r = await serviceHealth(T, REF);
    expect(seen).toEqual(["?services=auth&services=rest&services=realtime&services=storage&services=db"]);
    expect(r).toEqual({ ok: true, data: [{ name: "db", status: "ACTIVE_HEALTHY", error: null }, { name: "auth", status: "UNHEALTHY", error: "timeout" }] });
  });
});

describe("apiCounts", () => {
  it("sums the four request counters per bucket over 7 days", async () => {
    server.use(http.get(`${API}/v1/projects/${REF}/analytics/endpoints/usage.api-counts`, ({ request }) => {
      seen.push(new URL(request.url).searchParams.get("interval") ?? "");
      return HttpResponse.json({ result: [
        { timestamp: "2026-10-10T00:00:00Z", total_auth_requests: 1, total_realtime_requests: 0, total_rest_requests: 4, total_storage_requests: 0 },
        { timestamp: "2026-10-11T00:00:00Z", total_auth_requests: 0, total_realtime_requests: 0, total_rest_requests: 0, total_storage_requests: 0 },
      ] });
    }), catchAll);
    const r = await apiCounts(T, REF);
    expect(seen).toEqual(["7day"]);
    expect(r).toEqual({ ok: true, data: [{ at: new Date("2026-10-10T00:00:00Z"), total: 5 }, { at: new Date("2026-10-11T00:00:00Z"), total: 0 }] });
  });
  it("is transient when the analytics backend reports an error in the body", async () => {
    server.use(http.get(`${API}/v1/projects/${REF}/analytics/endpoints/usage.api-counts`, () => HttpResponse.json({ result: [], error: "upstream timeout" })), catchAll);
    expect(await apiCounts(T, REF)).toMatchObject({ ok: false, kind: "transient" });
  });
  it("reports a missing analytics_usage_read as a scope failure", async () => {
    server.use(http.get(`${API}/v1/projects/${REF}/analytics/endpoints/usage.api-counts`, () => HttpResponse.json({ message: "x", missing_permissions: ["analytics_usage_read"] }, { status: 403 })), catchAll);
    expect(await apiCounts(T, REF)).toMatchObject({ ok: false, kind: "scope", missing: ["analytics_usage_read"] });
  });
});

describe("databaseSize", () => {
  it("runs only the size query, read-only, and reads a bigint returned as string or number", async () => {
    const bodies: unknown[] = [];
    server.use(http.post(`${API}/v1/projects/${REF}/database/query/read-only`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json([{ bytes: "148897792" }]);
    }), catchAll);
    expect(await databaseSize(T, REF)).toEqual({ ok: true, data: 148_897_792 });
    expect(bodies).toEqual([{ query: SIZE_QUERY }]);
    expect(SIZE_QUERY).toBe("select pg_database_size(current_database())::bigint as bytes");
  });
});


describe("supabaseScopeCheck (D2)", () => {
  const projects = [
    { ref: REF, name: "portfolio", orgSlug: "org-a", region: "ap-southeast-1", createdAt: "", status: "ACTIVE_HEALTHY", pgVersion: "17" },
    { ref: "zyxwvutsrqponmlkjihg", name: "quillpad", orgSlug: "org-a", region: "ap-southeast-1", createdAt: "", status: "INACTIVE", pgVersion: "15" },
  ];
  it("probes one active project and the org, and never queries a database", async () => {
    const calls: string[] = [];
    server.use(
      http.get(`${API}/v1/projects/${REF}/health`, () => { calls.push("health"); return HttpResponse.json([]); }),
      http.get(`${API}/v1/projects/${REF}/analytics/endpoints/usage.api-counts`, () => { calls.push("counts"); return HttpResponse.json({ message: "x", missing_permissions: ["analytics_usage_read"] }, { status: 403 }); }),
      http.get(`${API}/v1/organizations/org-a`, () => { calls.push("org"); return HttpResponse.json({ id: "o", name: "A", plan: "free", opt_in_tags: [], allowed_release_channels: [] }); }),
      catchAll,
    );
    const r = await supabaseScopeCheck(T, projects);
    expect(calls.sort()).toEqual(["counts", "health", "org"]);
    expect(r.used).toEqual(["projects_read", "project_admin_read", "organization_admin_read"]);
    expect(r.missing).toEqual(["analytics_usage_read"]);
    expect(r.notes).toEqual(["Database read is checked at the first daily size read"]);
  });
  it("says what it couldn't check when no project is active", async () => {
    server.use(http.get(`${API}/v1/organizations/org-a`, () => HttpResponse.json({ id: "o", name: "A", plan: "free", opt_in_tags: [], allowed_release_channels: [] })), catchAll);
    const r = await supabaseScopeCheck(T, [projects[1]]);
    expect(r.notes).toContain("Health and API traffic are checked once a project is active");
  });
});

// Stage 6 A1: the only Supabase writes are pause, restore and the keep-alive's read-only `select 1`.
describe("getProject", () => {
  it("reads one project's live status", async () => {
    server.use(http.get(`${API}/v1/projects/${REF}`, () => HttpResponse.json({ id: REF, ref: REF, organization_slug: "org-a", name: "quillpad", region: "ap-southeast-1", created_at: "2026-07-27T00:00:00Z", status: "INACTIVE", database: { version: "15.8.1" } })), catchAll);
    expect(await getProject(T, REF)).toEqual({ ok: true, data: { ref: REF, name: "quillpad", orgSlug: "org-a", region: "ap-southeast-1", createdAt: "2026-07-27T00:00:00Z", status: "INACTIVE", pgVersion: "15.8.1" } });
  });
  it("is missing on a 404", async () => {
    server.use(http.get(`${API}/v1/projects/${REF}`, () => HttpResponse.json({ message: "not found" }, { status: 404 })), catchAll);
    expect(await getProject(T, REF)).toMatchObject({ ok: false, kind: "missing" });
  });
});

describe("pauseProject / restoreProject", () => {
  it.each([["pause", pauseProject], ["restore", restoreProject]] as const)("%s: POST to /v1/projects/{ref}/%s with no body", async (verb, fn) => {
    const got: { method: string; path: string; body: string; auth: string | null }[] = [];
    server.use(http.post(`${API}/v1/projects/${REF}/${verb}`, async ({ request }) => {
      got.push({ method: request.method, path: new URL(request.url).pathname, body: await request.text(), auth: request.headers.get("authorization") });
      return new HttpResponse(null, { status: 200 });
    }), catchAll);
    expect(await fn(T, REF)).toEqual({ ok: true, data: null });
    expect(got).toEqual([{ method: "POST", path: `/v1/projects/${REF}/${verb}`, body: "", auth: `Bearer ${T}` }]);
  });
  it.each([["pause", pauseProject], ["restore", restoreProject]] as const)("%s: a 403 with missing_permissions is a scope failure", async (verb, fn) => {
    server.use(http.post(`${API}/v1/projects/${REF}/${verb}`, () => HttpResponse.json({ message: "x", missing_permissions: ["project_admin_write"] }, { status: 403 })), catchAll);
    expect(await fn(T, REF)).toMatchObject({ ok: false, kind: "scope", missing: ["project_admin_write"] });
  });
  it.each([["pause", pauseProject], ["restore", restoreProject]] as const)("%s: any other 403 is a scope failure too (A6)", async (verb, fn) => {
    server.use(http.post(`${API}/v1/projects/${REF}/${verb}`, () => HttpResponse.json({ message: "Forbidden" }, { status: 403 })), catchAll);
    expect(await fn(T, REF)).toMatchObject({ ok: false, kind: "scope", status: 403 });
  });
  it("passes on Supabase's short refusal (e.g. no free slot) without the body", async () => {
    server.use(http.post(`${API}/v1/projects/${REF}/restore`, () => HttpResponse.json({ message: "Free plan limit reached" }, { status: 400 })), catchAll);
    const r = await restoreProject(T, REF);
    expect(r).toMatchObject({ ok: false, kind: "transient", status: 400 });
    expect(JSON.stringify(r)).not.toContain(T);
  });
});

describe("keepAlive", () => {
  it("sends only `select 1` to the read-only query endpoint", async () => {
    const bodies: unknown[] = [];
    server.use(http.post(`${API}/v1/projects/${REF}/database/query/read-only`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json([{ "?column?": 1 }]);
    }), catchAll);
    expect(await keepAlive(T, REF)).toEqual({ ok: true, data: null });
    expect(bodies).toEqual([{ query: "select 1" }]);
    expect(KEEP_ALIVE_QUERY).toBe("select 1");
  });
});

describe("write paths (A1, review focus 1)", () => {
  it("every write call is one of the allowed POSTs, and nothing else is ever sent", async () => {
    const calls: string[] = [];
    server.use(http.all(`${API}/*`, ({ request }) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json([{ ok: 1 }]);
    }));
    await pauseProject(T, REF);
    await restoreProject(T, REF);
    await keepAlive(T, REF);
    expect(calls).toEqual([
      `POST /v1/projects/${REF}/pause`,
      `POST /v1/projects/${REF}/restore`,
      `POST /v1/projects/${REF}/database/query/read-only`,
    ]);
  });
  it("encodes the ref, so an odd ref can't reach another path", async () => {
    const calls: string[] = [];
    server.use(http.all(`${API}/*`, ({ request }) => {
      calls.push(new URL(request.url).pathname);
      return HttpResponse.json(null);
    }));
    await pauseProject(T, "../organizations");
    expect(calls).toEqual(["/v1/projects/..%2Forganizations/pause"]);
  });
});
