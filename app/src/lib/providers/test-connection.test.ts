import { delay, http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { testConnection } from "./test-connection";

// MSW lets some unmatched requests through to the network; this catch-all (kept by resetHandlers) turns every
// unmatched request into a network error and records it, so a test can never reach a real provider.
const unmatched: string[] = [];
const catchAll = http.all("*", ({ request }) => { unmatched.push(request.url); return HttpResponse.error(); });
const server = setupServer(catchAll);
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  server.resetHandlers();
  expect(unmatched.splice(0)).toEqual([]);
});
afterAll(() => server.close());

const token = "tok_abcdefghijklmnopqrstuvwxyz";

describe("testConnection", () => {
  it("counts Vercel projects", async () => {
    server.use(http.get("https://api.vercel.com/v10/projects", () => HttpResponse.json({ projects: [{ name: "a" }, { name: "b" }], pagination: {} })));
    expect(await testConnection("vercel", token)).toEqual({ ok: true, summary: "Found 2 projects", details: ["Every permission it needs is there"] });
  });

  it("splits Supabase projects into active and paused, and lists the permissions it reads (D2)", async () => {
    const REF = "abcdefghijklmnopqrst";
    const row = (ref: string, name: string, status: string) => ({ ref, name, status, organization_slug: "org-a", region: "ap-southeast-1", created_at: "2026-01-01T00:00:00Z", database: { version: "17" } });
    server.use(
      http.get("https://api.supabase.com/v1/projects", () => HttpResponse.json([row(REF, "a", "ACTIVE_HEALTHY"), row("bbbbbbbbbbbbbbbbbbbb", "b", "INACTIVE"), row("cccccccccccccccccccc", "c", "ACTIVE_HEALTHY")])),
      http.get(`https://api.supabase.com/v1/projects/${REF}/health`, () => HttpResponse.json([])),
      http.get(`https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/usage.api-counts`, () => HttpResponse.json({ message: "x", missing_permissions: ["analytics_usage_read"] }, { status: 403 })),
      http.get("https://api.supabase.com/v1/organizations/org-a", () => HttpResponse.json({ id: "o", name: "A", plan: "free" })),
      catchAll,
    );
    expect(await testConnection("supabase", token)).toEqual({
      ok: true,
      summary: "Found 3 projects (2 active, 1 paused)",
      details: [
        "Missing analytics_usage_read: Last API traffic and Auto-pause risk stay empty",
        "Database read is checked at the first daily size read",
      ],
      scopeNote: "Reads projects, service health, organization plan · missing analytics_usage_read · database size checked daily",
    });
  });

  it("explains a rejected Neon key", async () => {
    server.use(http.get("https://console.neon.tech/api/v2/users/me/organizations", () => new HttpResponse(null, { status: 401 })), catchAll);
    expect(await testConnection("neon", token)).toEqual({ ok: false, kind: "auth", error: "Neon rejected this credential (401). Check that you copied all of it." });
  });

  it("counts Neon projects across the key's organizations", async () => {
    server.use(
      http.get("https://console.neon.tech/api/v2/users/me/organizations", () => HttpResponse.json({ organizations: [{ id: "org-1", name: "T" }] })),
      http.get("https://console.neon.tech/api/v2/projects", () => HttpResponse.json({ projects: [{ id: "p", name: "ticketer", region_id: "aws-ap-southeast-1", pg_version: 17, created_at: "2026-10-09T00:00:00Z" }] })),
      catchAll,
    );
    expect(await testConnection("neon", token)).toEqual({ ok: true, summary: "Found 1 project", details: ["Every permission it needs is there"] });
  });

  it("checks a Firebase service account live: token, projects, health read, Auth count and Cloud Monitoring", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const sa = JSON.stringify({ type: "service_account", project_id: "nova-wallet", client_email: "ops@nova-wallet.iam.gserviceaccount.com", private_key: privateKey });
    server.use(
      http.post("https://oauth2.googleapis.com/token", () => HttpResponse.json({ access_token: "ya29.fake" })),
      http.get("https://firebase.googleapis.com/v1beta1/projects", () => HttpResponse.json({ results: [{ projectId: "nova-wallet", displayName: "nova-wallet" }, { projectId: "orbit-blog", displayName: "orbit-blog" }] })),
      http.get("https://firestore.googleapis.com/v1/projects/nova-wallet/databases/(default)/documents/ops/ping", () => HttpResponse.json({ error: { code: 404, status: "NOT_FOUND", message: "Document not found." } }, { status: 404 })),
      http.post("https://identitytoolkit.googleapis.com/v1/projects/nova-wallet/accounts:query", () => HttpResponse.json({ recordsCount: "42" })),
      http.get("https://monitoring.googleapis.com/v3/projects/nova-wallet/timeSeries", () => HttpResponse.json({ error: { code: 403, status: "PERMISSION_DENIED", message: "x", details: [{ reason: "SERVICE_DISABLED" }] } }, { status: 403 })),
      catchAll,
    );
    expect(await testConnection("firebase", sa)).toEqual({
      ok: true,
      summary: "Found 2 Firebase projects",
      details: ["Firestore health read ✓ · Auth user count ✓", "Cloud Monitoring can't be read (SERVICE_DISABLED): reads, writes and deletes today stay empty"],
      scopeNote: "firebase.viewer, datastore.viewer, firebaseauth.viewer · no Cloud Monitoring",
    });
  });

  it("reports firebase.viewer when the project list answers, even if it holds only the account's own project", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const sa = JSON.stringify({ type: "service_account", project_id: "nova-wallet", client_email: "ops@nova-wallet.iam.gserviceaccount.com", private_key: privateKey });
    server.use(
      http.post("https://oauth2.googleapis.com/token", () => HttpResponse.json({ access_token: "ya29.fake" })),
      http.get("https://firebase.googleapis.com/v1beta1/projects", () => HttpResponse.json({ results: [{ projectId: "nova-wallet", displayName: "nova-wallet" }] })),
      http.get("https://firestore.googleapis.com/v1/projects/nova-wallet/databases/(default)/documents/ops/ping", () => HttpResponse.json({ error: { code: 404, status: "NOT_FOUND", message: "Document not found." } }, { status: 404 })),
      http.post("https://identitytoolkit.googleapis.com/v1/projects/nova-wallet/accounts:query", () => HttpResponse.json({ recordsCount: "1" })),
      http.get("https://monitoring.googleapis.com/v3/projects/nova-wallet/timeSeries", () => HttpResponse.json({ timeSeries: [] })),
      catchAll,
    );
    expect(await testConnection("firebase", sa)).toMatchObject({ ok: true, scopeNote: "firebase.viewer, datastore.viewer, firebaseauth.viewer, monitoring.viewer" });
  });

  it("names missing Supabase permissions", async () => {
    server.use(http.get("https://api.supabase.com/v1/projects", () => HttpResponse.json({ message: "forbidden", missing_permissions: ["analytics_usage_read"] }, { status: 403 })));
    expect(await testConnection("supabase", token)).toEqual({ ok: false, kind: "auth", error: "Missing permission: analytics_usage_read. Create a new token that includes it." });
  });

  it("counts Cloudflare zones", async () => {
    server.use(http.get("https://api.cloudflare.com/client/v4/zones", () => HttpResponse.json({ success: true, result: [{ name: "example.com" }] })));
    expect(await testConnection("cloudflare", token)).toMatchObject({ ok: true, summary: "Found 1 zone" });
  });

  it("gives up after the timeout instead of hanging", async () => {
    server.use(http.get("https://api.vercel.com/v10/projects", async () => {
      await delay(500);
      return HttpResponse.json({ projects: [] });
    }));
    expect(await testConnection("vercel", token, { timeoutMs: 30 })).toEqual({ ok: false, kind: "transient", error: "Vercel didn't answer within 5 seconds. Try again." });
  });

  it("reports provider outages without blaming the credential", async () => {
    server.use(http.get("https://api.vercel.com/v10/projects", () => new HttpResponse(null, { status: 503 })));
    expect(await testConnection("vercel", token)).toEqual({ ok: false, kind: "transient", error: "Vercel returned an error (503). Try again in a minute." });
  });

  it("marks rate limits and network failures as transient", async () => {
    server.use(http.get("https://api.vercel.com/v10/projects", () => new HttpResponse(null, { status: 429 })));
    expect(await testConnection("vercel", token)).toMatchObject({ ok: false, kind: "transient" });
    server.use(http.get("https://api.vercel.com/v10/projects", () => HttpResponse.error()));
    expect(await testConnection("vercel", token)).toEqual({ ok: false, kind: "transient", error: "Couldn't reach Vercel. Check your connection and try again." });
  });

  it("marks a 403 from a provider without permission details as auth", async () => {
    server.use(http.get("https://api.supabase.com/v1/projects", () => HttpResponse.json({ message: "forbidden" }, { status: 403 })));
    expect(await testConnection("supabase", token)).toMatchObject({ ok: false, kind: "auth" });
  });

  it("marks an answer it can't read as a format problem", async () => {
    server.use(http.get("https://api.vercel.com/v10/projects", () => HttpResponse.json({ nope: true })));
    expect(await testConnection("vercel", token)).toMatchObject({ ok: false, kind: "format" });
    server.use(http.get("https://api.vercel.com/v10/projects", () => new HttpResponse("<html>", { status: 200 })));
    expect(await testConnection("vercel", token)).toMatchObject({ ok: false, kind: "format" });
  });

  it("doesn't throw on invalid Firebase JSON", async () => {
    expect(await testConnection("firebase", "{not json")).toEqual({ ok: false, kind: "format", error: "Paste the whole JSON file. It needs client_email and private_key." });
  });
});
