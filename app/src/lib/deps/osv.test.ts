import { describe, expect, it } from "vitest";
import { type Advisory, BATCH_MAX, batchBodies, cveOf, cvss3Score, findings, fixedFor, parseAdvisory, parseBatch, scoreSeverity, severityOf } from "./osv";

const affected = (name: string, events: object[]) => [{ package: { name, ecosystem: "npm" }, ranges: [{ type: "SEMVER", events }] }];

describe("querybatch", () => {
  it("splits into batches of 1,000 npm queries", () => {
    const deps = Array.from({ length: BATCH_MAX + 1 }, (_, i) => ({ name: `p${i}`, version: "1.0.0", dev: false }));
    const b = batchBodies(deps);
    expect(b).toHaveLength(2);
    expect(b[0].queries).toHaveLength(BATCH_MAX);
    expect(b[1].queries).toEqual([{ package: { name: `p${BATCH_MAX}`, ecosystem: "npm" }, version: "1.0.0" }]);
  });

  it("reads the ids per query in order; a wrong shape or count → null", () => {
    expect(parseBatch({ results: [{ vulns: [{ id: "GHSA-aaaa-bbbb-cccc", modified: "x" }] }, {}] }, 2)).toEqual([["GHSA-aaaa-bbbb-cccc"], []]);
    expect(parseBatch({ results: [{}] }, 2)).toBeNull();
    expect(parseBatch({}, 0)).toBeNull();
    expect(parseBatch({ results: [{ vulns: [{ id: "../x" }] }] }, 1)).toEqual([[]]);
  });
});

describe("severity", () => {
  it("GitHub's label first", () => {
    expect(severityOf({ database_specific: { severity: "CRITICAL" } })).toBe("critical");
    expect(severityOf({ database_specific: { severity: "MODERATE" } })).toBe("moderate");
    expect(severityOf({ database_specific: { severity: "MEDIUM" } })).toBe("moderate");
  });

  it("then a CVSS v3 vector's base score", () => {
    expect(cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe(9.8);
    expect(cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N")).toBe(6.1);
    expect(cvss3Score("CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H")).toBe(7.5);
    expect(cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N")).toBe(0);
    expect(cvss3Score("CVSS:4.0/AV:N")).toBeNull();
    expect(cvss3Score("CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBeNull();
    expect(severityOf({ severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }] })).toBe("critical");
    expect([9, 7, 4, 0.1, 0].map(scoreSeverity)).toEqual(["critical", "high", "moderate", "low", "unknown"]);
  });

  it("a malicious package is critical; nothing readable is unknown", () => {
    expect(severityOf({ id: "MAL-2025-1" })).toBe("critical");
    expect(severityOf({ id: "GHSA-x" })).toBe("unknown");
  });
});

describe("parseAdvisory", () => {
  it("keeps id, CVE aliases, a one-line summary ≤ 200 and the withdrawn flag", () => {
    const a = parseAdvisory({ id: "GHSA-aaaa-bbbb-cccc", aliases: ["CVE-2025-29927", "CVE-2025-29927", "bad alias!"], summary: `  Auth   bypass ${"x".repeat(300)}`, withdrawn: "2025-01-01", affected: [] })!;
    expect(a.aliases).toEqual(["CVE-2025-29927"]);
    expect(a.summary.startsWith("Auth bypass x")).toBe(true);
    expect(a.summary).toHaveLength(200);
    expect(a.withdrawn).toBe(true);
    expect(parseAdvisory({ details: "x" })).toBeNull();
    expect(parseAdvisory({ id: "GHSA-1", details: "First line\nsecond" })?.summary).toBe("First line");
    expect(cveOf(["GHSA-1", "CVE-2024-1"])).toBe("CVE-2024-1");
    expect(cveOf([])).toBeNull();
  });
});

describe("fixedFor", () => {
  it("the lowest fix among the package's ranges that hold the version", () => {
    const aff = [
      ...affected("next", [{ introduced: "0" }, { fixed: "14.2.25" }, { introduced: "15.0.0" }, { fixed: "15.2.3" }]),
      ...affected("next", [{ introduced: "15.0.0" }, { fixed: "15.1.0" }]),
      ...affected("other", [{ introduced: "0" }, { fixed: "1.0.0" }]),
    ];
    expect(fixedFor(aff, "next", "15.0.5")).toBe("15.1.0");
    expect(fixedFor(aff, "next", "14.0.0")).toBe("14.2.25");
    expect(fixedFor(aff, "next", "15.3.0")).toBeNull();
    expect(fixedFor(affected("x", [{ introduced: "0" }, { last_affected: "2.0.0" }]), "x", "1.0.0")).toBeNull();
  });
});

describe("findings", () => {
  it("joins each dependency's ids with the advisories; withdrawn or unread ones are skipped", () => {
    const adv = new Map<string, Advisory>([
      ["GHSA-a", { id: "GHSA-a", aliases: ["CVE-2025-1"], summary: "Bad", severity: "high", withdrawn: false, affected: affected("next", [{ introduced: "0" }, { fixed: "15.2.3" }]) }],
      ["GHSA-w", { id: "GHSA-w", aliases: [], summary: "", severity: "low", withdrawn: true, affected: [] }],
    ]);
    const deps = [{ name: "next", version: "15.0.0", dev: false }, { name: "vitest", version: "1.0.0", dev: true }];
    expect(findings(deps, [["GHSA-a", "GHSA-w"], ["GHSA-missing"]], adv)).toEqual([
      { package: "next", installedVersion: "15.0.0", vulnId: "GHSA-a", aliases: ["CVE-2025-1"], severity: "high", fixedVersion: "15.2.3", summary: "Bad", dev: false, source: "osv" },
    ]);
  });
});
