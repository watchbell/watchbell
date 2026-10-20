import { readFileSync } from "node:fs";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { checkNextSecurity, dailyDeadline, MAX_SCRIPTS } from "./check";
import { OSV_URL } from "./osv";
import type { SecurityRow } from "./types";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const osv151 = JSON.parse(fixture("osv-next-15.1.0.json"));

// MSW lets unhandled requests for common assets (.js, .json, .html…) through to the real network even with
// onUnhandledFrame "error". This catch-all, kept by resetHandlers, turns every unmatched request into a network error
// and records it, so these tests can never reach a real site.
const unmatched: string[] = [];
const server = setupServer(http.all("*", ({ request }) => { unmatched.push(`${request.method} ${request.url}`); return HttpResponse.error(); }));
afterEach(() => { const leaked = unmatched.splice(0); expect(leaked).toEqual([]); });
const seen: string[] = [];
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => { server.resetHandlers(); seen.length = 0; });
afterAll(() => server.close());
server.events.on("request:start", ({ request }) => { seen.push(`${request.method} ${request.url}`); });

const SITE = "https://nova-wallet.vercel.app";
const lookup = vi.fn(async () => ["76.76.21.21"]);
const js = (body: string) => new HttpResponse(body, { headers: { "content-type": "application/javascript" } });
const html = (body: string, status = 200) => new HttpResponse(body, { status, headers: { "content-type": "text/html" } });
const prev: SecurityRow = {
  version: "15.1.0", status: "vulnerable", reason: null, checkedAt: new Date("2026-10-11T20:00:00Z"),
  findings: [{ id: "GHSA-f82v-jwr5-mffw", cve: "CVE-2025-29927", summary: "Authorization Bypass in Next.js Middleware", severity: "CRITICAL", fixed: "15.2.3" }],
};
const now = () => new Date("2026-10-12T20:00:00Z");

// The App Router page from the fixture: main-app has no version, the 1684 chunk has it.
function appRouterSite() {
  server.use(
    http.get(`${SITE}/`, () => html(fixture("app-router.html.txt"))),
    http.get(`${SITE}/_next/static/chunks/main-app-9c8d7e6f5a4b3c2d.js`, () => js("(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[1792],{}]);")),
    http.get(`${SITE}/_next/static/chunks/4bd1b696-6f1e2c3d4a5b6c7d.js`, () => js('t.version="19.0.0";')),
    http.get(`${SITE}/_next/static/chunks/1684-0a1b2c3d4e5f6a7b.js`, () => js(fixture("app-router-chunk.js.txt"))),
  );
}

describe("checkNextSecurity", () => {
  it("reads the version from the site's scripts, stops once found, and stores the OSV findings", async () => {
    appRouterSite();
    let osvBody: unknown = null;
    server.use(http.post(OSV_URL, async ({ request }) => { osvBody = await request.json(); return HttpResponse.json(osv151); }));
    const r = await checkNextSecurity("nova-wallet.vercel.app", null, { lookup, now });
    expect(r).toMatchObject({ version: "15.1.0", status: "vulnerable", reason: null, checkedAt: now() });
    expect(r!.findings.map((f) => [f.id, f.severity, f.fixed])).toEqual([
      ["GHSA-9qr9-h5gf-34mp", "CRITICAL", "15.1.9"], ["GHSA-f82v-jwr5-mffw", "CRITICAL", "15.2.3"],
      ["GHSA-g5qg-72qw-gw5v", "MODERATE", "15.4.5"], ["GHSA-qpjv-v59x-3qc4", "LOW", "15.1.6"],
    ]);
    expect(osvBody).toEqual({ package: { name: "next", ecosystem: "npm" }, version: "15.1.0" });
    expect(seen).toEqual([
      `GET ${SITE}/`,
      `GET ${SITE}/_next/static/chunks/main-app-9c8d7e6f5a4b3c2d.js`,
      `GET ${SITE}/_next/static/chunks/4bd1b696-6f1e2c3d4a5b6c7d.js`,
      `GET ${SITE}/_next/static/chunks/1684-0a1b2c3d4e5f6a7b.js`,
      `POST ${OSV_URL}`,
    ]);
    expect(lookup).toHaveBeenCalledWith("nova-wallet.vercel.app");
  });

  it("is ok when OSV knows nothing for the version", async () => {
    appRouterSite();
    server.use(http.post(OSV_URL, () => HttpResponse.json({})));
    expect(await checkNextSecurity("nova-wallet.vercel.app", prev, { lookup, now })).toEqual({
      version: "15.1.0", status: "ok", findings: [], reason: null, checkedAt: now(),
    });
  });

  it("reads a Pages Router site", async () => {
    server.use(
      http.get(`${SITE}/`, () => html('<script src="/_next/static/chunks/framework-1.js"></script><script src="/_next/static/chunks/main-2.js"></script>')),
      http.get(`${SITE}/_next/static/chunks/main-2.js`, () => js(fixture("pages-router-main.js.txt"))),
      http.post(OSV_URL, () => HttpResponse.json({})),
    );
    expect(await checkNextSecurity("nova-wallet.vercel.app", null, { lookup, now })).toMatchObject({ version: "14.2.3", status: "ok" });
    expect(seen).not.toContain(`GET ${SITE}/_next/static/chunks/framework-1.js`);
  });

  it("says a site isn't built with Next.js, and never asks OSV", async () => {
    server.use(http.get(`${SITE}/`, () => html(fixture("plain-site.html.txt"))));
    expect(await checkNextSecurity("nova-wallet.vercel.app", null, { lookup, now })).toEqual({
      version: null, status: "unknown", findings: [], reason: "not a Next.js site", checkedAt: now(),
    });
    expect(seen).toEqual([`GET ${SITE}/`]);
  });

  it("keeps a known vulnerability through an unknown read, with the new reason and time", async () => {
    server.use(http.get(`${SITE}/`, () => html(fixture("plain-site.html.txt"))));
    expect(await checkNextSecurity("nova-wallet.vercel.app", prev, { lookup, now })).toEqual({
      ...prev, status: "unknown", reason: "not a Next.js site", checkedAt: now(),
    });
  });

  it("never reads a version from the page HTML itself (a code sample on a blog)", async () => {
    server.use(
      http.get(`${SITE}/`, () => html('<pre>window.next={version:"13.0.0",appDir:!0}</pre><script>window.next={version:"13.0.0",appDir:!0}</script><script src="/_next/static/chunks/main-1.js"></script>')),
      http.get(`${SITE}/_next/static/chunks/main-1.js`, () => js("console.log(1)")),
    );
    expect(await checkNextSecurity("nova-wallet.vercel.app", null, { lookup, now })).toMatchObject({ version: null, status: "unknown", reason: "version not exposed" });
  });

  it("never reads another host's scripts when the page redirects away (a login page)", async () => {
    server.use(
      http.get(`${SITE}/`, () => new HttpResponse(null, { status: 302, headers: { location: "https://vercel.com/login?next=%2F" } })),
      http.get("https://vercel.com/login", () => html(fixture("app-router.html.txt"))),
    );
    expect(await checkNextSecurity("nova-wallet.vercel.app", prev, { lookup, now })).toEqual({
      ...prev, status: "unknown", reason: "the site redirects to another host", checkedAt: now(),
    });
    expect(seen).toEqual([`GET ${SITE}/`]);
  });

  it("accepts a redirect that only adds or drops www.", async () => {
    const WWW = "https://www.nova.example.com";
    server.use(
      http.get("https://nova.example.com/", () => new HttpResponse(null, { status: 308, headers: { location: `${WWW}/` } })),
      http.get(`${WWW}/`, () => html('<script src="/_next/static/chunks/main-app-1.js"></script>')),
      http.get(`${WWW}/_next/static/chunks/main-app-1.js`, () => js('window.next={version:"16.4.0",appDir:!0}')),
      http.post(OSV_URL, () => HttpResponse.json({})),
    );
    expect(await checkNextSecurity("nova.example.com", null, { lookup, now })).toMatchObject({ version: "16.4.0", status: "ok" });
  });

  it("never follows a script redirect to another origin", async () => {
    server.use(
      http.get(`${SITE}/`, () => html('<script src="/_next/static/chunks/main-app-1.js"></script>')),
      http.get(`${SITE}/_next/static/chunks/main-app-1.js`, () => new HttpResponse(null, { status: 302, headers: { location: "https://cdn.other.example/x.js" } })),
    );
    expect(await checkNextSecurity("nova-wallet.vercel.app", prev, { lookup, now })).toMatchObject({ status: "error", findings: prev.findings });
    expect(seen.some((s) => s.includes("cdn.other.example"))).toBe(false);
  });

  it("marks an error, keeping the result, when no script could be read at all", async () => {
    server.use(
      http.get(`${SITE}/`, () => html('<script src="/_next/static/chunks/main-app-1.js"></script><script src="/_next/static/chunks/2-x.js"></script>')),
      http.get(`${SITE}/_next/static/chunks/:file`, () => new HttpResponse("oops", { status: 500 })),
    );
    expect(await checkNextSecurity("nova-wallet.vercel.app", prev, { lookup, now })).toEqual({
      ...prev, status: "error", reason: "Couldn't load the site's scripts", checkedAt: now(),
    });
  });

  it("says the version isn't exposed when no script holds it, reading at most 12 files", async () => {
    const tags = Array.from({ length: 20 }, (_, i) => `<script src="/_next/static/chunks/${i}-x.js"></script>`).join("");
    server.use(
      http.get(`${SITE}/`, () => html(tags)),
      http.get(`${SITE}/_next/static/chunks/:file`, () => js("console.log(1)")),
    );
    expect(await checkNextSecurity("nova-wallet.vercel.app", null, { lookup, now })).toMatchObject({ version: null, status: "unknown", reason: "version not exposed" });
    expect(seen.filter((s) => s.includes("/_next/static/"))).toHaveLength(MAX_SCRIPTS);
    seen.length = 0;
    expect(await checkNextSecurity("nova-wallet.vercel.app", prev, { lookup, now })).toEqual({ ...prev, status: "unknown", reason: "version not exposed", checkedAt: now() });
  });

  it("keeps the previous result and marks an error when OSV fails", async () => {
    appRouterSite();
    server.use(http.post(OSV_URL, () => new HttpResponse("busy", { status: 503 })));
    expect(await checkNextSecurity("nova-wallet.vercel.app", prev, { lookup, now })).toEqual({
      ...prev, status: "error", reason: "OSV.dev answered HTTP 503", checkedAt: now(),
    });
  });

  it("keeps the previous result when the site itself doesn't load", async () => {
    server.use(http.get(`${SITE}/`, () => html("Bad gateway", 502)));
    expect(await checkNextSecurity("nova-wallet.vercel.app", prev, { lookup, now })).toEqual({
      ...prev, status: "error", reason: "Couldn't load the site: HTTP 502", checkedAt: now(),
    });
    const first = await checkNextSecurity("nova-wallet.vercel.app", null, { lookup, now });
    expect(first).toEqual({ version: null, status: "error", findings: [], reason: "Couldn't load the site: HTTP 502", checkedAt: now() });
  });

  it("refuses a host that resolves to a private address, without a request", async () => {
    const r = await checkNextSecurity("nova-wallet.vercel.app", null, { lookup: async () => ["10.0.0.7"], now });
    expect(r).toMatchObject({ status: "error", reason: "Couldn't load the site: Blocked address" });
    expect(seen).toEqual([]);
  });

  it("skips (null) when the caller's deadline has already passed", async () => {
    expect(await checkNextSecurity("nova-wallet.vercel.app", prev, { lookup, now, deadline: Date.now() - 1 })).toBeNull();
    expect(seen).toEqual([]);
  });
});

describe("dailyDeadline", () => {
  it("gives the daily step about 35 s, but never past 55 s into the 60 s run", () => {
    const started = 1_000_000;
    expect(dailyDeadline(started, started + 5_000)).toBe(started + 40_000);
    expect(dailyDeadline(started, started + 30_000)).toBe(started + 55_000);
  });
});
