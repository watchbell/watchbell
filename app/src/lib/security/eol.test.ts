import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EOL_URL, eolLine, fetchNextCycles, parseEol, type EolData } from "./eol";

const catchAll = http.all("*", ({ request }) => {
  throw new Error(`Unexpected request: ${request.method} ${request.url}`);
});
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// endoflife.date API v1 on 12 Oct 2026 (trimmed).
const body = { schema_version: "1.2.0", result: { name: "nextjs", releases: [
  { name: "16", label: "16 (LTS)", isEol: false, eolFrom: null, isMaintained: true, latest: { name: "16.4.0", date: "2026-10-01" } },
  { name: "15", label: "15 (LTS)", isEol: false, eolFrom: "2026-10-21", isMaintained: true, latest: { name: "15.5.27", date: "2026-09-30" } },
  { name: "14", label: "14 (LTS)", isEol: true, eolFrom: "2025-10-26", isMaintained: false, latest: { name: "14.2.35", date: "2025-12-01" } },
] } };
const now = new Date("2026-10-12T15:00:00Z");
const data: EolData = { cycles: parseEol(body)!, checkedAt: now.toISOString() };

describe("parseEol and fetchNextCycles", () => {
  it("keeps name, isEol, eolFrom and the latest patch", () => {
    expect(parseEol(body)?.[1]).toEqual({ name: "15", isEol: false, eolFrom: "2026-10-21", latest: "15.5.27" });
    expect(parseEol({ result: {} })).toBeNull();
  });
  it("fetches the Next.js product", async () => {
    server.use(http.get(EOL_URL, () => HttpResponse.json(body)), catchAll);
    expect(await fetchNextCycles()).toEqual({ ok: true, cycles: data.cycles });
  });
  it("a failure is an error, never an empty list", async () => {
    server.use(http.get(EOL_URL, () => new HttpResponse(null, { status: 500 })), catchAll);
    expect(await fetchNextCycles()).toEqual({ ok: false, error: "endoflife.date returned an error (500)" });
  });
});

describe("eolLine (R1)", () => {
  it("a supported major on its latest patch", () => {
    expect(eolLine("16.4.0", data, now)).toEqual({ state: "ok", text: "Next.js 16 is supported", note: null });
  });
  it("a supported major behind its latest patch names the patch", () => {
    expect(eolLine("16.3.8", data, now)).toEqual({ state: "ok", text: "Next.js 16 is supported", note: "16.4.0 is the latest 16.x" });
  });
  it("end of life within 60 days warns with the date and the latest version", () => {
    expect(eolLine("15.5.27", data, now)).toEqual({ state: "warn", text: "Next.js 15 reaches end of life on 21 Oct 2026 (in 9 days)", note: "latest is 16.4.0" });
  });
  it("past end of life is an error", () => {
    expect(eolLine("14.2.3", data, now)).toEqual({ state: "err", text: "Next.js 14 reached end of life on 26 Oct 2025", note: "latest is 16.4.0" });
  });
  it("unknown without a version, without data, or for a cycle endoflife.date doesn't list", () => {
    expect(eolLine(null, data, now)).toEqual({ state: "unknown", text: "Unknown until the version is read", note: null });
    expect(eolLine("16.4.0", null, now)).toEqual({ state: "unknown", text: "Unknown · endoflife.date hasn't been read yet", note: null });
    expect(eolLine("9.5.0", data, now)).toEqual({ state: "unknown", text: "Unknown · endoflife.date has no cycle 9", note: null });
  });
});
