import { describe, expect, it } from "vitest";
import {
  compareNodeVersions, nodeVerdict, nodeWarningLine, parseNodeEol, parseNodeIndex, parseNodeVersion, storedNodeCycles, storedNodeIndex,
} from "./node-runtime.mjs";

// D20: the shape of nodejs.org/dist/index.json (newest first; trimmed to the fields the verdict reads plus `date`/`lts`).
const rel = (version: string, security: boolean, lts: string | false = false) => ({ version, date: "2026-10-21", lts, security, files: [] });
const INDEX = [
  rel("v26.12.1", true),
  rel("v26.12.0", false),
  rel("v26.5.1", true),
  rel("v25.9.0", false),
  rel("v24.22.2", false, "Krypton"), // a later non-security release
  rel("v24.22.1", true, "Krypton"),
  rel("v24.18.1", true, "Krypton"),
  rel("v24.12.0", false, "Krypton"),
  rel("v22.23.4", true, "Jod"),
  rel("v20.20.2", true, "Iron"),
  rel("v20.19.0", false, "Iron"),
];
const EOL = { result: { releases: [
  { name: "26", isEol: false, eolFrom: "2029-04-30", latest: { name: "26.12.1" } },
  { name: "25", isEol: true, eolFrom: "2026-06-01", latest: { name: "25.9.0" } },
  { name: "24", isEol: false, eolFrom: "2028-04-30", latest: { name: "24.22.1" } },
  { name: "22", isEol: false, eolFrom: "2027-04-30", latest: { name: "22.23.4" } },
  { name: "20", isEol: false, eolFrom: "2026-04-30", latest: { name: "20.20.2" } }, // stale flag: the date has passed
] } };
const NOW = Date.UTC(2026, 9, 25, 12);
const index = parseNodeIndex(INDEX)!;
const cycles = parseNodeEol(EOL)!;
const verdict = (v: string, over: Partial<Parameters<typeof nodeVerdict>[1]> = {}) => nodeVerdict(v, { index, indexFresh: true, cycles, ...over }, NOW);

describe("parseNodeVersion / compareNodeVersions", () => {
  it("reads process.version and plain versions, pre-releases included", () => {
    expect(parseNodeVersion("v24.12.0")).toEqual({ major: 24, minor: 12, patch: 0, pre: null, text: "24.12.0" });
    expect(parseNodeVersion("26.0.0-rc.1")?.text).toBe("26.0.0-rc.1");
    for (const bad of ["", "v24", "24.1", "node 24.1.0", "v24.1.0; rm -rf /", null, 24]) expect(parseNodeVersion(bad)).toBeNull();
  });
  it("compares numerically, across v26 lines and against pre-releases", () => {
    const c = (a: string, b: string) => Math.sign(compareNodeVersions(parseNodeVersion(a)!, parseNodeVersion(b)!));
    expect(c("26.12.1", "26.5.1")).toBe(1); // 12 > 5, not "1" < "5"
    expect(c("26.2.0", "26.12.0")).toBe(-1);
    expect(c("24.22.1", "24.22.1")).toBe(0);
    expect(c("26.0.0-rc.1", "26.0.0")).toBe(-1);
    expect(c("26.0.0", "26.0.0-rc.2")).toBe(1);
    expect(c("26.0.0-rc.1", "26.0.0-rc.2")).toBe(-1);
    expect(c("26.0.0", "24.99.99")).toBe(1);
  });
});

describe("parseNodeIndex", () => {
  it("keeps the security releases newest first and each line's newest release", () => {
    expect(index.security).toEqual(["26.12.1", "26.5.1", "24.22.1", "24.18.1", "22.23.4", "20.20.2"]);
    expect(index.latest).toEqual({ 26: "26.12.1", 25: "25.9.0", 24: "24.22.2", 22: "22.23.4", 20: "20.20.2" });
  });
  it("rejects a malformed index as a whole: no list, an empty list, or any entry it can't read", () => {
    for (const bad of [
      null, {}, "<html>captive portal</html>", [],
      [rel("v24.22.1", true), { version: "v24.22.0" }], // no security flag
      [rel("v24.22.1", true), { version: "v24.22.0", security: "yes" }],
      [rel("v24.22.1", true), rel("24.22.0", false)], // not nodejs.org's "v" form
      [rel("v24.22.1", true), rel("v24.x", false)],
      [rel("v24.22.1", true), null],
    ]) expect(parseNodeIndex(bad)).toBeNull();
  });
});

describe("parseNodeEol", () => {
  it("reads endoflife.date's cycles and refuses another shape", () => {
    expect(cycles[0]).toEqual({ name: "26", isEol: false, eolFrom: "2029-04-30" });
    for (const bad of [null, {}, { result: {} }, { result: { releases: [] } }, { result: { releases: [{ name: "24", isEol: "no" }] } },
      { result: { releases: [{ name: "24", isEol: false, eolFrom: "April 2028" }] } }]) expect(parseNodeEol(bad)).toBeNull();
  });
});

describe("nodeVerdict", () => {
  it("flags a version with a newer security release in its line, fixed in the newest one", () => {
    expect(verdict("v24.12.0")).toMatchObject({ kind: "vulnerable", state: "warn", fixedIn: "24.22.1", text: "Node 24.12.0: security fix available (24.22.1)" });
    expect(verdict("v24.18.1").fixedIn).toBe("24.22.1");
    expect(verdict("v26.11.1")).toMatchObject({ kind: "vulnerable", fixedIn: "26.12.1" }); // 26.12 vs 26.5: compared as numbers
    expect(verdict("v26.0.0-rc.1")).toMatchObject({ kind: "vulnerable", fixedIn: "26.12.1" });
  });
  it("a version equal to the fix, or newer, is ok", () => {
    expect(verdict("v24.22.1")).toMatchObject({ kind: "ok", state: "ok", text: "Node 24.22.1: ok" });
    expect(verdict("v26.12.1").kind).toBe("ok");
    expect(verdict("v22.23.4").kind).toBe("ok");
    expect(verdict("v24.23.0").kind).toBe("ok"); // newer than the index
  });
  it("a newer non-security release doesn't make an older one vulnerable", () => {
    expect(verdict("v24.22.1").kind).toBe("ok"); // 24.22.2 exists but isn't a security release
    expect(verdict("v26.12.0").fixedIn).toBe("26.12.1"); // the security release after it does
    expect(nodeVerdict("v26.12.0", { index: parseNodeIndex([rel("v26.12.1", false), rel("v26.12.0", false)]), indexFresh: true, cycles }, NOW).kind).toBe("ok");
  });
  it("only looks at the version's own line", () => {
    expect(verdict("v22.23.4").kind).toBe("ok"); // 24.22.1 and 26.12.1 are other lines
  });
  it("reports a line past end of life as EOL whatever its patch level, by flag or by date", () => {
    expect(verdict("v25.9.0")).toMatchObject({ kind: "eol", state: "err", eolFrom: "2026-06-01", text: "Node 25.9.0: end of life since 2026-06-01, no more security fixes" });
    expect(verdict("v20.20.2")).toMatchObject({ kind: "eol", eolFrom: "2026-04-30" }); // the newest 20.x, still EOL
    expect(nodeVerdict("v20.20.2", { index, indexFresh: true, cycles }, Date.UTC(2026, 3, 29)).kind).toBe("ok"); // the day before
    expect(verdict("v20.19.0").kind).toBe("eol"); // EOL wins over "fix available"
  });
  it("is unknown, never ok, without fresh data", () => {
    expect(verdict("v24.22.1", { indexFresh: false })).toMatchObject({ kind: "unknown", state: "unknown", text: "Node 24.22.1: unknown (nodejs.org couldn't be read on the last try)" });
    expect(verdict("v24.22.1", { index: null, indexFresh: false }).text).toBe("Node 24.22.1: unknown (nodejs.org hasn't been read yet)");
    expect(verdict("v24.22.1", { cycles: null }).text).toBe("Node 24.22.1: unknown (endoflife.date hasn't been read yet)");
    expect(verdict("v23.11.1").text).toBe("Node 23.11.1: unknown (nodejs.org lists no Node 23 release)");
    expect(nodeVerdict("v24.22.1", { index, indexFresh: true, cycles: cycles.filter((c) => c.name !== "24") }, NOW).text)
      .toBe("Node 24.22.1: unknown (endoflife.date has no Node 24 line)");
    expect(verdict("not a version")).toMatchObject({ kind: "unknown", version: null });
  });
  it("still warns from older data: a security release never goes away", () => {
    expect(verdict("v24.12.0", { indexFresh: false }).kind).toBe("vulnerable");
    expect(verdict("v25.9.0", { index: null, indexFresh: false }).kind).toBe("eol");
  });
});

describe("nodeWarningLine", () => {
  it("one line for vulnerable or EOL, none otherwise", () => {
    expect(nodeWarningLine(verdict("v24.12.0"))).toBe("warning: Node.js 24.12.0 has a security fix available (24.22.1). Update Node.js, then restart Watchbell.");
    expect(nodeWarningLine(verdict("v25.9.0"))).toBe("warning: Node.js 25.9.0 is past end of life (since 2026-06-01) and gets no security fixes. Move to a supported Node.js line, then restart Watchbell.");
    expect(nodeWarningLine(verdict("v24.22.1"))).toBeNull();
    expect(nodeWarningLine(verdict("v24.22.1", { indexFresh: false }))).toBeNull();
  });
  it("names an installed service's own Node.js and tells to install the service again", () => {
    expect(nodeWarningLine(verdict("v24.12.0"), { service: "/opt/node-24.12.0/bin/node" })).toBe(
      "warning: the Watchbell service's Node.js (/opt/node-24.12.0/bin/node), version 24.12.0, has a security fix available (24.22.1). Update Node.js, then run watchbell service install again.",
    );
    expect(nodeWarningLine(verdict("v25.9.0"), { service: "/opt/n25/node" })).toBe(
      "warning: the Watchbell service's Node.js (/opt/n25/node), version 25.9.0, is past end of life (since 2026-06-01) and gets no security fixes. Move to a supported Node.js line, then run watchbell service install again.",
    );
    expect(nodeWarningLine(verdict("v24.22.1"), { service: "/x/node" })).toBeNull();
  });
});

describe("stored data", () => {
  it("reads back what was written and refuses anything else", () => {
    expect(storedNodeIndex(JSON.parse(JSON.stringify(index)))).toEqual(index);
    expect(storedNodeCycles(JSON.parse(JSON.stringify(cycles)))).toEqual(cycles);
    for (const bad of [null, "x", { security: "24.22.1", latest: {} }, { security: ["24.x"], latest: {} }, { security: [], latest: { 24: "26.1.0" } }]) {
      expect(storedNodeIndex(bad)).toBeNull();
    }
    expect(storedNodeCycles(null)).toBeNull();
  });
});
