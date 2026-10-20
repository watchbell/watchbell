import { describe, expect, it } from "vitest";
import { advisories, DETAILS_MAX, queryBatch } from "./osv-client";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const deps = [{ name: "next", version: "15.0.0", dev: false }, { name: "zod", version: "3.22.0", dev: false }];

describe("queryBatch", () => {
  it("POSTs one querybatch with npm queries and returns the ids in order", async () => {
    const seen: { url: string; method?: string; body: unknown }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
      return json({ results: [{ vulns: [{ id: "GHSA-a", modified: "2025-01-01" }] }, {}] });
    }) as unknown as typeof globalThis.fetch;
    expect(await queryBatch(deps, { fetch, deadline: Date.now() + 10_000 })).toEqual({ ok: true, ids: [["GHSA-a"], []] });
    expect(seen).toEqual([{ url: "https://api.osv.dev/v1/querybatch", method: "POST", body: { queries: [
      { package: { name: "next", ecosystem: "npm" }, version: "15.0.0" }, { package: { name: "zod", ecosystem: "npm" }, version: "3.22.0" },
    ] } }]);
  });

  it("fails on an HTTP error, a strange answer, or no time left", async () => {
    const bad = (async () => json({}, 503)) as unknown as typeof globalThis.fetch;
    expect(await queryBatch(deps, { fetch: bad, deadline: Date.now() + 10_000 })).toEqual({ ok: false, error: "OSV.dev answered HTTP 503" });
    const odd = (async () => json({ results: [] })) as unknown as typeof globalThis.fetch;
    expect(await queryBatch(deps, { fetch: odd, deadline: Date.now() + 10_000 })).toEqual({ ok: false, error: "OSV.dev sent an answer we couldn't read" });
    expect(await queryBatch(deps, { fetch: odd, deadline: Date.now() })).toEqual({ ok: false, error: "No time left for OSV.dev" });
  });
});

describe("advisories", () => {
  it("GETs each unique id once", async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      return json({ id: url.split("/").pop(), summary: "x", database_specific: { severity: "HIGH" } });
    }) as unknown as typeof globalThis.fetch;
    const r = await advisories(["GHSA-a", "GHSA-b", "GHSA-a"], { fetch, deadline: Date.now() + 10_000 });
    expect(r.ok && [...r.map.keys()]).toEqual(["GHSA-a", "GHSA-b"]);
    expect(urls.sort()).toEqual(["https://api.osv.dev/v1/vulns/GHSA-a", "https://api.osv.dev/v1/vulns/GHSA-b"]);
  });

  it("fails closed when any advisory can't be read, or there are too many", async () => {
    const fetch = (async (url: string) => (url.endsWith("GHSA-b") ? json({}, 500) : json({ id: "GHSA-a" }))) as unknown as typeof globalThis.fetch;
    expect(await advisories(["GHSA-a", "GHSA-b"], { fetch, deadline: Date.now() + 10_000 })).toEqual({ ok: false, error: "OSV.dev answered HTTP 500" });
    const many = Array.from({ length: DETAILS_MAX + 1 }, (_, i) => `GHSA-${i}`);
    expect(await advisories(many, { fetch, deadline: Date.now() + 10_000 })).toMatchObject({ ok: false });
  });
});
