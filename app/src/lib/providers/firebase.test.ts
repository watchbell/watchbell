import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authUserCount, discoverFirebase, firestoreOps, firestorePing, listFirebaseProjects } from "./firebase";

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
const TOK = "ya29.fake";
const DOC = "https://firestore.googleapis.com/v1/projects/nova-wallet/databases/(default)/documents/ops/ping";
const sa = { type: "service_account" as const, project_id: "nova-wallet", client_email: "ops@nova-wallet.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE " + "KEY-----x" };

describe("firestorePing", () => {
  it("is reachable when the health document exists or is simply missing", async () => {
    server.use(http.get(DOC, () => HttpResponse.json({ name: "x", fields: {} })), catchAll);
    expect(await firestorePing(TOK, "nova-wallet")).toMatchObject({ ok: true, data: { reachable: true, noDatabase: false } });
    server.use(http.get(DOC, () => HttpResponse.json({ error: { code: 404, status: "NOT_FOUND", message: 'Document "projects/nova-wallet/databases/(default)/documents/ops/ping" not found.' } }, { status: 404 })), catchAll);
    expect(await firestorePing(TOK, "nova-wallet")).toMatchObject({ ok: true, data: { reachable: true, noDatabase: false } });
  });
  it("says when the project has no Firestore database", async () => {
    server.use(http.get(DOC, () => HttpResponse.json({ error: { code: 404, status: "NOT_FOUND", message: "The database (default) does not exist for project nova-wallet" } }, { status: 404 })), catchAll);
    expect(await firestorePing(TOK, "nova-wallet")).toMatchObject({ ok: true, data: { reachable: false, noDatabase: true } });
  });
  it("passes a used-up daily quota through as RESOURCE_EXHAUSTED", async () => {
    server.use(http.get(DOC, () => HttpResponse.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded." } }, { status: 429 })), catchAll);
    expect(await firestorePing(TOK, "nova-wallet")).toMatchObject({ ok: false, kind: "transient", reason: "RESOURCE_EXHAUSTED" });
  });
});

describe("authUserCount", () => {
  it("asks Identity Toolkit for the count only", async () => {
    const bodies: unknown[] = [];
    server.use(http.post("https://identitytoolkit.googleapis.com/v1/projects/nova-wallet/accounts:query", async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({ recordsCount: "42" });
    }), catchAll);
    expect(await authUserCount(TOK, "nova-wallet")).toEqual({ ok: true, data: 42 });
    expect(bodies).toEqual([{ returnUserInfo: false }]);
  });
});

describe("firestoreOps", () => {
  it("sums today's read, write and delete counts from Cloud Monitoring", async () => {
    const filters: string[] = [];
    server.use(http.get("https://monitoring.googleapis.com/v3/projects/nova-wallet/timeSeries", ({ request }) => {
      const u = new URL(request.url);
      const f = u.searchParams.get("filter") ?? "";
      filters.push(f.replace(/.*document\/(\w+)_ops_count.*/, "$1"));
      expect(u.searchParams.get("aggregation.perSeriesAligner")).toBe("ALIGN_SUM");
      const n = f.includes("read") ? ["2000", "100"] : f.includes("write") ? ["310"] : [];
      return HttpResponse.json(n.length ? { timeSeries: [{ points: n.map((v) => ({ value: { int64Value: v } })) }] } : {});
    }), catchAll);
    const r = await firestoreOps(TOK, "nova-wallet", new Date("2026-10-12T07:00:00Z"), new Date("2026-10-12T12:00:00Z"));
    expect(r).toEqual({ ok: true, data: { reads: 2100, writes: 310, deletes: 0 } });
    expect(filters.sort()).toEqual(["delete", "read", "write"]);
  });
  it("is a scope failure when Cloud Monitoring is off or the role is missing (Needs test on Spark)", async () => {
    server.use(http.get("https://monitoring.googleapis.com/v3/projects/nova-wallet/timeSeries", () => HttpResponse.json({ error: { code: 403, status: "PERMISSION_DENIED", message: "Cloud Monitoring API has not been used in project", details: [{ reason: "SERVICE_DISABLED" }] } }, { status: 403 })), catchAll);
    expect(await firestoreOps(TOK, "nova-wallet", new Date(0), new Date(60_000))).toMatchObject({ ok: false, kind: "scope", reason: "SERVICE_DISABLED" });
  });
});

describe("discoverFirebase", () => {
  it("lists the projects the service account can see, plus its own", async () => {
    server.use(http.get("https://firebase.googleapis.com/v1beta1/projects", () => HttpResponse.json({ results: [
      { projectId: "orbit-blog", displayName: "orbit-blog", state: "ACTIVE" }, { projectId: "old", displayName: "old", state: "DELETED" },
    ] })), catchAll);
    const r = await discoverFirebase(sa, TOK);
    expect(r.ok && r.data.map((p) => p.projectId).sort()).toEqual(["nova-wallet", "orbit-blog"]);
  });
  it("falls back to the service account's own project without firebase.viewer", async () => {
    server.use(http.get("https://firebase.googleapis.com/v1beta1/projects", () => HttpResponse.json({ error: { code: 403, status: "PERMISSION_DENIED", message: "denied" } }, { status: 403 })), catchAll);
    expect(await discoverFirebase(sa, TOK)).toEqual({ ok: true, data: [{ projectId: "nova-wallet", displayName: "nova-wallet" }] });
  });
});

describe("listFirebaseProjects", () => {
  it("is a format failure on an odd answer", async () => {
    server.use(http.get("https://firebase.googleapis.com/v1beta1/projects", () => HttpResponse.json({ results: "x" })), catchAll);
    expect(await listFirebaseProjects(TOK)).toMatchObject({ ok: false, kind: "format" });
  });
});
