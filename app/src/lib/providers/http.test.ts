import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { callJson } from "./http";

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
const URL_ = "https://api.example.test/x";
const answer = (status: number, body: Parameters<typeof HttpResponse.json>[0], headers: Record<string, string> = {}) =>
  server.use(http.all(URL_, () => HttpResponse.json(body, { status, headers })), catchAll);

describe("callJson", () => {
  it("returns the JSON body on 2xx and sends the bearer token", async () => {
    let auth = "";
    server.use(http.get(URL_, ({ request }) => { auth = request.headers.get("authorization") ?? ""; return HttpResponse.json({ a: 1 }); }), catchAll);
    expect(await callJson("X", URL_, { token: "tok" })).toEqual({ ok: true, data: { a: 1 } });
    expect(auth).toBe("Bearer tok");
  });
  it("reads Supabase's missing_permissions as a scope failure, not a bad credential", async () => {
    answer(403, { message: "forbidden", missing_permissions: ["analytics_usage_read"] });
    expect(await callJson("Supabase", URL_, { token: "t" })).toMatchObject({ ok: false, kind: "scope", missing: ["analytics_usage_read"], error: "Missing permission: analytics_usage_read." });
  });
  it("reads a Google 403 as a scope failure with its reason", async () => {
    answer(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "Cloud Monitoring API has not been used", details: [{ reason: "SERVICE_DISABLED" }] } });
    expect(await callJson("Google", URL_, { token: "t" })).toMatchObject({ ok: false, kind: "scope", reason: "SERVICE_DISABLED" });
  });
  it("treats 401, a plain 403 and Google's invalid_grant as a rejected credential", async () => {
    answer(401, {});
    expect(await callJson("X", URL_, { token: "t" })).toMatchObject({ ok: false, kind: "auth", status: 401 });
    answer(403, { message: "nope" });
    expect(await callJson("X", URL_, { token: "t" })).toMatchObject({ ok: false, kind: "auth", status: 403 });
    answer(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
    expect(await callJson("Google", URL_, { method: "POST", form: new URLSearchParams({ a: "b" }) })).toMatchObject({ ok: false, kind: "auth" });
  });
  it("keeps 404 apart, with the provider's message", async () => {
    answer(404, { error: { code: 404, status: "NOT_FOUND", message: "The database (default) does not exist for project p" } });
    expect(await callJson("Firestore", URL_, { token: "t" })).toMatchObject({ ok: false, kind: "missing", message: "The database (default) does not exist for project p" });
  });
  it("honours Retry-After on 429 and names an exhausted quota", async () => {
    answer(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded." } }, { "Retry-After": "120" });
    expect(await callJson("Firestore", URL_, { token: "t" })).toMatchObject({ ok: false, kind: "transient", retryAfterS: 120, reason: "RESOURCE_EXHAUSTED", error: "Firestore says a quota is used up." });
  });
  it("calls a network failure or a 5xx transient", async () => {
    server.use(http.get(URL_, () => HttpResponse.error()), catchAll);
    expect(await callJson("X", URL_, { token: "t" })).toMatchObject({ ok: false, kind: "transient", error: "Couldn't reach X." });
    answer(503, {});
    expect(await callJson("X", URL_, { token: "t" })).toMatchObject({ ok: false, kind: "transient", status: 503 });
  });
});
