import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as cf from "./cloudflare";
import { certificatePacks, getDnsRecord, listDnsRecords, listZones, MAX_RECORD_PAGES, sslMode, tokenStatus, updateDnsRecord } from "./cloudflare";

const API = "https://api.cloudflare.com/client/v4";
const token = "cf_abcdefghijklmnopqrstuvwxyz0123";
const zoneId = "0123456789abcdef0123456789abcdef";
// Last handler: anything not matched above fails the test instead of reaching the network.
const catchAll = http.all("*", ({ request }) => {
  throw new Error(`Unexpected request: ${request.method} ${request.url}`);
});
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
const use = (...h: Parameters<typeof server.use>) => server.use(...h, catchAll);
const ok = (result: unknown, info?: { page: number; total_pages: number }) => HttpResponse.json({ success: true, errors: [], messages: [], result, result_info: info });

describe("listZones", () => {
  it("reads every page with a bearer token and maps the fields", async () => {
    const seen: string[] = [];
    use(http.get(`${API}/zones`, ({ request }) => {
      const url = new URL(request.url);
      seen.push(`${url.searchParams.get("page")}|${request.headers.get("authorization")}|${request.method}`);
      const page = Number(url.searchParams.get("page"));
      const zone = { id: `z${page}`, name: `zone${page}.example.com`, status: "active", paused: false, name_servers: ["ada.ns.cloudflare.com"], account: { id: "acc1", name: "Acme" } };
      return ok([zone], { page, total_pages: 2 });
    }));
    const r = await listZones(token);
    expect(r).toEqual({ ok: true, data: [
      { id: "z1", name: "zone1.example.com", status: "active", paused: false, nameServers: ["ada.ns.cloudflare.com"], accountId: "acc1", accountName: "Acme" },
      { id: "z2", name: "zone2.example.com", status: "active", paused: false, nameServers: ["ada.ns.cloudflare.com"], accountId: "acc1", accountName: "Acme" },
    ] });
    expect(seen).toEqual([`1|Bearer ${token}|GET`, `2|Bearer ${token}|GET`]);
  });
  it("a 401 or 403 on the zone list means the token itself is bad", async () => {
    use(http.get(`${API}/zones`, () => HttpResponse.json({ success: false, errors: [{ code: 9109, message: "Invalid access token" }] }, { status: 403 })));
    expect(await listZones(token)).toMatchObject({ ok: false, kind: "auth", status: 403 });
  });
  it("a 429 is transient and carries Retry-After", async () => {
    use(http.get(`${API}/zones`, () => new HttpResponse(null, { status: 429, headers: { "Retry-After": "120" } })));
    expect(await listZones(token)).toMatchObject({ ok: false, kind: "transient", status: 429, retryAfterS: 120 });
  });
  it("a 5xx is transient; success:false or a strange body is a format failure", async () => {
    use(http.get(`${API}/zones`, () => new HttpResponse(null, { status: 502 })));
    expect(await listZones(token)).toMatchObject({ ok: false, kind: "transient", status: 502 });
    server.resetHandlers();
    use(http.get(`${API}/zones`, () => HttpResponse.json({ success: false, errors: [{ code: 1000, message: "nope" }], result: null })));
    expect(await listZones(token)).toMatchObject({ ok: false, kind: "format" });
  });
});

describe("listDnsRecords", () => {
  it("maps records and stops after MAX_RECORD_PAGES with truncated", async () => {
    let calls = 0;
    use(http.get(`${API}/zones/${zoneId}/dns_records`, ({ request }) => {
      calls++;
      const page = Number(new URL(request.url).searchParams.get("page"));
      return ok([{ id: `r${page}`, type: "CNAME", name: "app.example.com", content: "x.vercel-dns-017.com", proxied: true, ttl: 1, comment: null }], { page, total_pages: 9 });
    }));
    const r = await listDnsRecords(token, zoneId);
    expect(calls).toBe(MAX_RECORD_PAGES);
    expect(r.ok && r.data.truncated).toBe(true);
    expect(r.ok && r.data.records[0]).toEqual({ id: "r1", type: "CNAME", name: "app.example.com", content: "x.vercel-dns-017.com", proxied: true, ttl: 1, comment: null });
  });
  it("a 403 here is a missing DNS permission, not a bad token", async () => {
    use(http.get(`${API}/zones/${zoneId}/dns_records`, () => new HttpResponse(null, { status: 403 })));
    expect(await listDnsRecords(token, zoneId)).toMatchObject({ ok: false, kind: "scope", error: expect.stringContaining("DNS Read") });
  });
});

describe("sslMode and certificatePacks", () => {
  it("reads the SSL/TLS mode; 403 names Zone Settings Read", async () => {
    use(http.get(`${API}/zones/${zoneId}/settings/ssl`, () => ok({ id: "ssl", value: "strict", editable: true })));
    expect(await sslMode(token, zoneId)).toEqual({ ok: true, data: "strict" });
    server.resetHandlers();
    use(http.get(`${API}/zones/${zoneId}/settings/ssl`, () => new HttpResponse(null, { status: 403 })));
    expect(await sslMode(token, zoneId)).toMatchObject({ ok: false, kind: "scope", error: expect.stringContaining("Zone Settings Read") });
  });
  it("asks for packs of every status and keeps each pack's soonest expiry", async () => {
    use(http.get(`${API}/zones/${zoneId}/ssl/certificate_packs`, ({ request }) => {
      expect(new URL(request.url).searchParams.get("status")).toBe("all");
      return ok([{ id: "p1", type: "universal", status: "active", hosts: ["example.com", "*.example.com"],
        certificates: [{ id: "c1", expires_on: "2027-01-02T00:00:00Z" }, { id: "c2", expires_on: "2026-12-09T00:00:00Z" }] }]);
    }));
    expect(await certificatePacks(token, zoneId)).toEqual({ ok: true, data: [
      { type: "universal", status: "active", hosts: ["example.com", "*.example.com"], expiresOn: "2026-12-09T00:00:00Z" },
    ] });
  });
});

describe("tokenStatus", () => {
  it("reads the status and expiry; no expiry is null", async () => {
    use(http.get(`${API}/user/tokens/verify`, () => ok({ id: "t", status: "active", expires_on: "2027-09-10T00:00:00Z" })));
    expect(await tokenStatus(token)).toEqual({ ok: true, data: { status: "active", expiresAt: new Date("2027-09-10T00:00:00Z") } });
    server.resetHandlers();
    use(http.get(`${API}/user/tokens/verify`, () => ok({ id: "t", status: "active" })));
    expect(await tokenStatus(token)).toEqual({ ok: true, data: { status: "active", expiresAt: null } });
  });
});

// Stage 6 slice 2 (B1): the only Cloudflare write is PATCH of one existing record. No create, no PUT, no delete.
describe("DNS record read and edit", () => {
  const recordId = "fedcba9876543210fedcba9876543210";
  const live = { id: recordId, type: "CNAME", name: "tiket.example.com", content: "d5e6f7.vercel-dns-017.com", proxied: true, ttl: 1, comment: null, meta: {} };
  const body = { type: "CNAME", name: "tiket.example.com", content: "d5e6f7.vercel-dns-017.com", ttl: 1, proxied: false };

  it("getDnsRecord reads one record with the bearer token", async () => {
    use(http.get(`${API}/zones/${zoneId}/dns_records/${recordId}`, ({ request }) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
      return ok(live);
    }));
    expect(await getDnsRecord(token, zoneId, recordId)).toEqual({ ok: true, data: { id: recordId, type: "CNAME", name: "tiket.example.com", content: "d5e6f7.vercel-dns-017.com", proxied: true, ttl: 1, comment: null } });
  });
  it("getDnsRecord: 404 is missing, 403 a missing DNS Read permission", async () => {
    use(http.get(`${API}/zones/${zoneId}/dns_records/${recordId}`, () => new HttpResponse(null, { status: 404 })));
    expect(await getDnsRecord(token, zoneId, recordId)).toMatchObject({ ok: false, kind: "missing", status: 404 });
    server.resetHandlers();
    use(http.get(`${API}/zones/${zoneId}/dns_records/${recordId}`, () => new HttpResponse(null, { status: 403 })));
    expect(await getDnsRecord(token, zoneId, recordId)).toMatchObject({ ok: false, kind: "scope", status: 403, error: expect.stringContaining("DNS Read") });
  });

  it("updateDnsRecord PATCHes the record with exactly the body given and maps the answer", async () => {
    const seen: { method: string; path: string; body: unknown; auth: string | null; type: string | null }[] = [];
    use(http.patch(`${API}/zones/${zoneId}/dns_records/${recordId}`, async ({ request }) => {
      seen.push({ method: request.method, path: new URL(request.url).pathname, body: await request.json(), auth: request.headers.get("authorization"), type: request.headers.get("content-type") });
      return ok({ ...live, proxied: false });
    }));
    const r = await updateDnsRecord(token, zoneId, recordId, body);
    expect(r).toEqual({ ok: true, data: { id: recordId, type: "CNAME", name: "tiket.example.com", content: "d5e6f7.vercel-dns-017.com", proxied: false, ttl: 1, comment: null } });
    expect(seen).toEqual([{ method: "PATCH", path: `/client/v4/zones/${zoneId}/dns_records/${recordId}`, body, auth: `Bearer ${token}`, type: "application/json" }]);
  });

  it("updateDnsRecord: 403 names Zone → DNS → Edit, 401 is auth, 404 missing, 429 transient with Retry-After", async () => {
    let status = 403;
    use(http.patch(`${API}/zones/${zoneId}/dns_records/${recordId}`, () => new HttpResponse(JSON.stringify({ success: false, errors: [{ code: 10000, message: "secret body" }] }), { status, headers: { "Retry-After": "30" } })));
    const denied = await updateDnsRecord(token, zoneId, recordId, body);
    expect(denied).toMatchObject({ ok: false, kind: "scope", status: 403, error: expect.stringContaining("Zone → DNS → Edit") });
    status = 401;
    expect(await updateDnsRecord(token, zoneId, recordId, body)).toMatchObject({ ok: false, kind: "auth", status: 401 });
    status = 404;
    expect(await updateDnsRecord(token, zoneId, recordId, body)).toMatchObject({ ok: false, kind: "missing", status: 404 });
    status = 429;
    expect(await updateDnsRecord(token, zoneId, recordId, body)).toMatchObject({ ok: false, kind: "transient", status: 429, retryAfterS: 30 });
    expect(JSON.stringify(denied)).not.toContain("secret body");
  });

  it("a refused edit names Cloudflare's numeric error code, never its message", async () => {
    use(http.patch(`${API}/zones/${zoneId}/dns_records/${recordId}`, () => HttpResponse.json({ success: false, errors: [{ code: 9005, message: "Content for A record is invalid <secret>" }] }, { status: 400 })));
    const r = await updateDnsRecord(token, zoneId, recordId, body);
    expect(r).toEqual({ ok: false, kind: "transient", status: 400, error: "Cloudflare refused this change (400, code 9005)." });
  });

  it("an edit that times out says it may still have happened", async () => {
    use(http.patch(`${API}/zones/${zoneId}/dns_records/${recordId}`, async () => { await new Promise((r) => setTimeout(r, 200)); return ok(live); }));
    const r = await updateDnsRecord(token, zoneId, recordId, body, { timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, kind: "transient", error: expect.stringContaining("may still have happened") });
  });

  it("every exported function together makes only GETs and the one PATCH: no POST, PUT or DELETE", async () => {
    const methods: string[] = [];
    server.use(http.all(`${API}/*`, ({ request }) => {
      methods.push(request.method);
      const u = request.url;
      return ok(u.includes("/dns_records/") ? live : u.includes("settings/ssl") ? { value: "full" } : u.includes("tokens/verify") ? { status: "active" } : []);
    }));
    await listZones(token);
    await listDnsRecords(token, zoneId);
    await sslMode(token, zoneId);
    await certificatePacks(token, zoneId);
    await tokenStatus(token);
    await getDnsRecord(token, zoneId, recordId);
    await updateDnsRecord(token, zoneId, recordId, body);
    expect([...new Set(methods)].sort()).toEqual(["GET", "PATCH"]);
    expect(methods.filter((m) => m === "PATCH")).toHaveLength(1);
    // The module exports no other request function.
    const fns = Object.entries(cf).filter(([, v]) => typeof v === "function").map(([k]) => k).sort();
    expect(fns).toEqual(["certificatePacks", "getDnsRecord", "listDnsRecords", "listZones", "sslMode", "tokenStatus", "updateDnsRecord"]);
  });
});
