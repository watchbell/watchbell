import { describe, expect, it } from "vitest";
import {
  fetchNodeAdvisories, mergeNodeRead, nodeCheckOff, NODE_EOL_URL, NODE_FRESH_MS, NODE_INDEX_URL, parseNodeAdvisories, runtimeLine, type NodeAdvisories,
} from "./node-runtime";

const INDEX = [
  { version: "v24.22.1", date: "2026-10-20", lts: "Krypton", security: true },
  { version: "v24.12.0", date: "2026-05-01", lts: "Krypton", security: false },
];
const EOL = { result: { releases: [{ name: "24", isEol: false, eolFrom: "2028-04-30", latest: { name: "24.22.1" } }] } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const stub = (answers: Record<string, () => Promise<Response>>) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return answers[url]();
  }) as unknown as typeof fetch;
  return { f, calls };
};
const NOW = new Date("2026-10-25T12:00:00Z");

describe("fetchNodeAdvisories", () => {
  it("makes one plain GET to each source, with a timeout, and parses both", async () => {
    const { f, calls } = stub({ [NODE_INDEX_URL]: async () => json(INDEX), [NODE_EOL_URL]: async () => json(EOL) });
    const r = await fetchNodeAdvisories({ fetch: f, timeoutMs: 1000 });
    expect(r).toMatchObject({ indexError: null, cyclesError: null, index: { security: ["24.22.1"] }, cycles: [{ name: "24" }] });
    expect(calls.map((c) => c.url).sort()).toEqual([NODE_EOL_URL, NODE_INDEX_URL].sort());
    for (const c of calls) {
      expect(c.init?.method).toBe("GET");
      expect(c.init?.signal).toBeInstanceOf(AbortSignal);
      expect(c.init?.body).toBeUndefined();
      // Fix round 1 (M4): gzip only, never the Brotli decoder the advisory is about.
      expect(c.init?.headers).toEqual({ Accept: "application/json", "Accept-Encoding": "gzip" });
    }
  });
  it("says what failed, per source, and never throws", async () => {
    const offline = stub({ [NODE_INDEX_URL]: () => Promise.reject(new TypeError("fetch failed")), [NODE_EOL_URL]: async () => json({}, 503) });
    expect(await fetchNodeAdvisories({ fetch: offline.f })).toEqual({
      index: null, indexError: "Couldn't reach nodejs.org", cycles: null, cyclesError: "endoflife.date returned an error (503)",
    });
    const odd = stub({ [NODE_INDEX_URL]: async () => new Response("<html>portal</html>"), [NODE_EOL_URL]: async () => json({ result: {} }) });
    expect(await fetchNodeAdvisories({ fetch: odd.f })).toMatchObject({
      indexError: "nodejs.org answered in a format the console doesn't recognise", cyclesError: "endoflife.date answered in a format the console doesn't recognise",
    });
  });
});

describe("nodeCheckOff", () => {
  it("is on for a set switch, off for unset, empty or 0/false/no/off; the old name counts", () => {
    for (const v of ["1", "true", "yes", " 1 "]) expect(nodeCheckOff({ WATCHBELL_NO_UPDATE_CHECK: v })).toEqual({ off: true, name: "WATCHBELL_NO_UPDATE_CHECK" });
    for (const v of [undefined, "", " ", "0", "false", "NO", "off"]) expect(nodeCheckOff({ WATCHBELL_NO_UPDATE_CHECK: v }).off).toBe(false);
    expect(nodeCheckOff({ WATCHPOST_NO_UPDATE_CHECK: "1" })).toEqual({ off: true, name: "WATCHPOST_NO_UPDATE_CHECK" });
    expect(nodeCheckOff({}).name).toBe("WATCHBELL_NO_UPDATE_CHECK");
  });
});

describe("mergeNodeRead / parseNodeAdvisories", () => {
  const good = { index: { security: ["24.22.1"], latest: { 24: "24.22.1" } }, indexError: null, cycles: [{ name: "24", isEol: false, eolFrom: "2028-04-30" }], cyclesError: null };
  it("keeps the last good data of a source that failed and records why", () => {
    const first = mergeNodeRead(null, good, NOW);
    const later = new Date(NOW.getTime() + 12 * 3_600_000);
    const next = mergeNodeRead(first, { index: null, indexError: "Couldn't reach nodejs.org", cycles: null, cyclesError: null }, later);
    expect(next).toEqual({ ...first, indexCheckedAt: later.toISOString(), indexError: "Couldn't reach nodejs.org", cyclesCheckedAt: later.toISOString() });
  });
  it("reads a stored row back through the same checks", () => {
    const row = mergeNodeRead(null, good, NOW);
    expect(parseNodeAdvisories(JSON.parse(JSON.stringify(row)))).toEqual(row);
    expect(parseNodeAdvisories({ index: { security: ["nope"], latest: {} }, indexCheckedAt: "x" })).toMatchObject({ index: null, indexCheckedAt: null, cycles: null });
    expect(parseNodeAdvisories(null)).toBeNull();
  });
});

describe("runtimeLine", () => {
  const data = (over: Partial<NodeAdvisories> = {}): NodeAdvisories => ({
    index: { security: ["24.22.1"], latest: { 24: "24.22.1" } }, indexCheckedAt: NOW.toISOString(), indexError: null,
    cycles: [{ name: "24", isEol: false, eolFrom: "2028-04-30" }], cyclesCheckedAt: NOW.toISOString(), cyclesError: null, ...over,
  });
  it("shows the fix for a vulnerable runtime and ok for a patched one", () => {
    expect(runtimeLine("v24.12.0", data(), NOW)).toEqual({ state: "warn", text: "Node 24.12.0: security fix available (24.22.1)", note: null });
    expect(runtimeLine("v24.22.1", data(), NOW)).toEqual({ state: "ok", text: "Node 24.22.1: ok", note: null });
  });
  it("is unknown when the latest read failed, the data is too old, or nothing was read", () => {
    expect(runtimeLine("v24.22.1", data({ indexError: "Couldn't reach nodejs.org" }), NOW)).toEqual({
      state: "unknown", text: "Node 24.22.1: unknown (nodejs.org couldn't be read on the last try)", note: "Last read: Couldn't reach nodejs.org",
    });
    const old = new Date(NOW.getTime() - NODE_FRESH_MS).toISOString();
    expect(runtimeLine("v24.22.1", data({ indexCheckedAt: old }), NOW).state).toBe("unknown");
    expect(runtimeLine("v24.22.1", data({ indexCheckedAt: "2099-01-01T00:00:00.000Z" }), NOW).state).toBe("unknown"); // a clock moved back
    expect(runtimeLine("v24.22.1", null, NOW)).toMatchObject({ state: "unknown", text: "Node 24.22.1: unknown (nodejs.org hasn't been read yet)" });
  });
  it("still warns when the latest read failed but the last good data shows a fix", () => {
    expect(runtimeLine("v24.12.0", data({ indexError: "Couldn't reach nodejs.org" }), NOW).state).toBe("warn");
  });
  it("says the check is off when WATCHBELL_NO_UPDATE_CHECK is set, whatever the data", () => {
    expect(runtimeLine("v24.12.0", data(), NOW, { off: true, name: "WATCHBELL_NO_UPDATE_CHECK" })).toEqual({
      state: "off", text: "Node 24.12.0: check turned off (WATCHBELL_NO_UPDATE_CHECK)", note: null,
    });
    expect(runtimeLine("v24.12.0", data(), NOW, { off: false, name: "WATCHBELL_NO_UPDATE_CHECK" }).state).toBe("warn");
  });
  it("reads this process's own version", () => {
    expect(runtimeLine(process.version, data(), NOW).text.startsWith(`Node ${process.version.slice(1)}:`)).toBe(true);
  });
});
