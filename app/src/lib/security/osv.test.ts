import { readFileSync } from "node:fs";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fixedFor, OSV_URL, parseOsv, queryOsv } from "./osv";

const osvFixture = JSON.parse(readFileSync(new URL("./fixtures/osv-next-15.1.0.json", import.meta.url), "utf8"));

// MSW lets unhandled requests for common assets (.js, .json, .html…) through to the real network even with
// onUnhandledFrame "error". This catch-all, kept by resetHandlers, turns every unmatched request into a network error
// and records it, so these tests can never reach a real site.
const unmatched: string[] = [];
const server = setupServer(http.all("*", ({ request }) => { unmatched.push(`${request.method} ${request.url}`); return HttpResponse.error(); }));
afterEach(() => { const leaked = unmatched.splice(0); expect(leaked).toEqual([]); });
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const nextAffected = (events: Record<string, string>[]) => ({ package: { name: "next", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events }] });

describe("parseOsv", () => {
  it("keeps id, CVE alias, summary, severity and the fix for the running branch, worst first", () => {
    expect(parseOsv(osvFixture, "15.1.0")).toEqual([
      { id: "GHSA-9qr9-h5gf-34mp", cve: "CVE-2025-66478", summary: "Next.js is vulnerable to RCE in React flight protocol", severity: "CRITICAL", fixed: "15.1.9" },
      { id: "GHSA-f82v-jwr5-mffw", cve: "CVE-2025-29927", summary: "Authorization Bypass in Next.js Middleware", severity: "CRITICAL", fixed: "15.2.3" },
      { id: "GHSA-g5qg-72qw-gw5v", cve: "CVE-2025-57752", summary: "Next.js Affected by Cache Key Confusion for Image Optimization API Routes", severity: "MODERATE", fixed: "15.4.5" },
      { id: "GHSA-qpjv-v59x-3qc4", cve: "CVE-2025-32421", summary: "Next.js Race Condition to Cache Poisoning", severity: "LOW", fixed: "15.1.6" },
    ]);
  });
  it("picks the fix from the range that holds the version, on another branch too", () => {
    expect(parseOsv(osvFixture, "14.1.0")!.find((f) => f.id === "GHSA-f82v-jwr5-mffw")?.fixed).toBe("14.2.25");
    expect(parseOsv(osvFixture, "14.1.0")!.find((f) => f.id === "GHSA-g5qg-72qw-gw5v")?.fixed).toBe("14.2.31");
  });
  it("falls back to UNKNOWN severity, no CVE, and no fix when OSV gives none", () => {
    const r = parseOsv({
      vulns: [{ id: "GHSA-aaaa-bbbb-cccc", aliases: ["PYSEC-1"], affected: [nextAffected([{ introduced: "15.0.0" }, { last_affected: "15.1.2" }])] }],
    }, "15.1.0");
    expect(r).toEqual([{ id: "GHSA-aaaa-bbbb-cccc", cve: null, summary: "", severity: "UNKNOWN", fixed: null }]);
  });
  it("reads severity case-insensitively and maps MEDIUM to MODERATE", () => {
    const r = parseOsv({ vulns: [
      { id: "A", database_specific: { severity: "high" }, affected: [] },
      { id: "B", database_specific: { severity: "MEDIUM" }, affected: [] },
      { id: "C", database_specific: { severity: "whatever" }, affected: [] },
    ] }, "15.1.0");
    expect(r!.map((f) => [f.id, f.severity])).toEqual([["A", "HIGH"], ["B", "MODERATE"], ["C", "UNKNOWN"]]);
  });
  it("skips withdrawn advisories and entries without an id, and ignores other packages' ranges", () => {
    const r = parseOsv({ vulns: [
      { id: "GONE", withdrawn: "2025-01-01T00:00:00Z", affected: [] },
      { summary: "no id" },
      { id: "X", affected: [
        { package: { name: "react-server-dom-webpack", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.0" }] }] },
        nextAffected([{ introduced: "15.0.0" }, { fixed: "15.1.1" }]),
      ] },
    ] }, "15.1.0");
    expect(r).toEqual([{ id: "X", cve: null, summary: "", severity: "UNKNOWN", fixed: "15.1.1" }]);
  });
  it("caps the list at 50 and trims long summaries", () => {
    const vulns = Array.from({ length: 60 }, (_, i) => ({ id: `GHSA-${String(i).padStart(4, "0")}`, summary: "x".repeat(400), affected: [] }));
    const r = parseOsv({ vulns }, "15.1.0");
    expect(r).toHaveLength(50);
    expect(r![0].summary.length).toBeLessThanOrEqual(200);
  });
  it("reads {} and an empty list as a clean answer", () => {
    expect(parseOsv({}, "15.1.0")).toEqual([]);
    expect(parseOsv({ vulns: [] }, "15.1.0")).toEqual([]);
  });
  it("fails closed (null) on anything that isn't an OSV answer, never 'no findings'", () => {
    expect(parseOsv(null, "15.1.0")).toBeNull();
    expect(parseOsv([], "15.1.0")).toBeNull();
    expect(parseOsv("<html>", "15.1.0")).toBeNull();
    expect(parseOsv({ vulns: "nope" }, "15.1.0")).toBeNull();
    expect(parseOsv({ vulns: {} }, "15.1.0")).toBeNull();
    expect(parseOsv({ vulns: [{ summary: "no id" }, 3, null] }, "15.1.0")).toBeNull();
  });
  it("still reads a list where only withdrawn advisories were dropped", () => {
    expect(parseOsv({ vulns: [{ id: "GONE", withdrawn: "2025-01-01T00:00:00Z" }] }, "15.1.0")).toEqual([]);
  });
});

describe("fixedFor", () => {
  it("walks introduced/fixed pairs and takes the lowest fix whose range holds the version", () => {
    const a = [nextAffected([{ introduced: "0" }, { fixed: "14.2.24" }, { introduced: "15.0.0" }, { fixed: "15.1.6" }])];
    expect(fixedFor(a, "15.1.0")).toBe("15.1.6");
    expect(fixedFor(a, "14.0.0")).toBe("14.2.24");
    expect(fixedFor(a, "15.1.6")).toBeNull();
  });
  it("counts a canary-introduced range as holding its release", () => {
    expect(fixedFor([nextAffected([{ introduced: "15.1.0-canary.0" }, { fixed: "15.1.9" }])], "15.1.0")).toBe("15.1.9");
  });
});

describe("queryOsv", () => {
  it("POSTs the npm package and version and parses the answer", async () => {
    let body: unknown = null;
    server.use(http.post(OSV_URL, async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(osvFixture);
    }));
    const r = await queryOsv("15.1.0");
    expect(body).toEqual({ package: { name: "next", ecosystem: "npm" }, version: "15.1.0" });
    expect(r.ok && r.findings.map((f) => f.id)).toEqual(["GHSA-9qr9-h5gf-34mp", "GHSA-f82v-jwr5-mffw", "GHSA-g5qg-72qw-gw5v", "GHSA-qpjv-v59x-3qc4"]);
  });
  it("returns no findings for a clean version (OSV answers {})", async () => {
    server.use(http.post(OSV_URL, () => HttpResponse.json({})));
    expect(await queryOsv("16.4.0")).toEqual({ ok: true, findings: [] });
  });
  it("reports an HTTP error in words", async () => {
    server.use(http.post(OSV_URL, () => new HttpResponse("busy", { status: 503 })));
    expect(await queryOsv("15.1.0")).toEqual({ ok: false, error: "OSV.dev answered HTTP 503" });
  });
  it("reports a body that isn't JSON", async () => {
    server.use(http.post(OSV_URL, () => new HttpResponse("<html>", { status: 200, headers: { "content-type": "text/html" } })));
    expect(await queryOsv("15.1.0")).toEqual({ ok: false, error: "OSV.dev sent an answer we couldn't read" });
  });
  it("gives up at the timeout", async () => {
    server.use(http.post(OSV_URL, () => new Promise<Response>(() => undefined)));
    expect(await queryOsv("15.1.0", { timeoutMs: 30 })).toEqual({ ok: false, error: "OSV.dev didn't answer within 30 ms" });
  });
  it("fails closed on a 200 that isn't an OSV answer", async () => {
    server.use(http.post(OSV_URL, () => HttpResponse.json([])));
    expect(await queryOsv("15.1.0")).toEqual({ ok: false, error: "OSV.dev sent an answer we couldn't read" });
    server.use(http.post(OSV_URL, () => HttpResponse.json({ vulns: "nope" })));
    expect(await queryOsv("15.1.0")).toEqual({ ok: false, error: "OSV.dev sent an answer we couldn't read" });
  });
  it("stops reading an answer over the size cap", async () => {
    server.use(http.post(OSV_URL, () => HttpResponse.json({ vulns: [], pad: "x".repeat(3000) })));
    expect(await queryOsv("15.1.0", { maxBytes: 1000 })).toEqual({ ok: false, error: "OSV.dev sent too large an answer" });
  });
  it("follows next_page_token, at most 3 pages", async () => {
    const tokens: (string | null)[] = [];
    server.use(http.post(OSV_URL, async ({ request }) => {
      const body = (await request.json()) as { page_token?: string };
      tokens.push(body.page_token ?? null);
      const n = tokens.length;
      return HttpResponse.json({ vulns: [{ id: `GHSA-page-${n}` }], next_page_token: `t${n}` });
    }));
    const r = await queryOsv("15.1.0");
    expect(tokens).toEqual([null, "t1", "t2"]);
    expect(r.ok && r.findings.map((f) => f.id)).toEqual(["GHSA-page-1", "GHSA-page-2", "GHSA-page-3"]);
  });
  it("reports a network failure", async () => {
    server.use(http.post(OSV_URL, () => HttpResponse.error()));
    expect(await queryOsv("15.1.0")).toEqual({ ok: false, error: "Couldn't reach OSV.dev" });
  });
});
