import { describe, expect, it } from "vitest";
import { fixedInAll, securityEvent, severityRank, sortFindings, worstSeverity } from "./rules";
import type { Finding, SecurityRow } from "./types";

const f = (id: string, severity: Finding["severity"], fixed: string | null = null): Finding => ({ id, cve: null, summary: "", severity, fixed });
const row = (over: Partial<SecurityRow>): SecurityRow => ({ version: "15.1.0", status: "ok", findings: [], reason: null, checkedAt: new Date(0), ...over });

describe("severity", () => {
  it("orders CRITICAL > HIGH > MODERATE > LOW > UNKNOWN", () => {
    expect(["LOW", "CRITICAL", "UNKNOWN", "MODERATE", "HIGH"].sort((a, b) => severityRank(b as Finding["severity"]) - severityRank(a as Finding["severity"])))
      .toEqual(["CRITICAL", "HIGH", "MODERATE", "LOW", "UNKNOWN"]);
  });
  it("names the worst one, UNKNOWN for none", () => {
    expect(worstSeverity([f("a", "LOW"), f("b", "HIGH"), f("c", "MODERATE")])).toBe("HIGH");
    expect(worstSeverity([])).toBe("UNKNOWN");
  });
  it("sorts worst first, then by id", () => {
    expect(sortFindings([f("b", "LOW"), f("z", "CRITICAL"), f("a", "LOW"), f("c", "CRITICAL")]).map((x) => x.id)).toEqual(["c", "z", "a", "b"]);
  });
});

describe("fixedInAll", () => {
  it("is the highest per-finding fix, the first version that clears them all", () => {
    expect(fixedInAll([f("a", "LOW", "15.1.6"), f("b", "CRITICAL", "15.2.3"), f("c", "MODERATE", "15.10.0"), f("d", "HIGH")])).toBe("15.10.0");
  });
  it("is null when no finding has a fix", () => {
    expect(fixedInAll([f("a", "LOW")])).toBeNull();
  });
});

describe("securityEvent", () => {
  const two = [f("GHSA-1", "CRITICAL", "15.2.3"), f("GHSA-2", "MODERATE", "15.4.5")];

  it("fires when an app newly becomes vulnerable: err for CRITICAL/HIGH", () => {
    expect(securityEvent("nova-wallet", row({ status: "ok" }), row({ status: "vulnerable", findings: two }))).toEqual({
      kind: "err", message: "nova-wallet runs Next.js 15.1.0 with 2 known vulnerabilities (critical)", detail: "GHSA-1, GHSA-2",
    });
  });
  it("fires on the first check too, warn below HIGH, singular wording", () => {
    expect(securityEvent("a", null, row({ status: "vulnerable", findings: [f("GHSA-3", "MODERATE")] }))).toEqual({
      kind: "warn", message: "a runs Next.js 15.1.0 with 1 known vulnerability (moderate)", detail: "GHSA-3",
    });
  });
  it("fires again when a new finding id appears", () => {
    expect(securityEvent("a", row({ status: "vulnerable", findings: [two[1]] }), row({ status: "vulnerable", findings: two }))?.kind).toBe("err");
  });
  it("stays quiet when the findings are the same, or only shrink", () => {
    expect(securityEvent("a", row({ status: "vulnerable", findings: two }), row({ status: "vulnerable", findings: [...two].reverse() }))).toBeNull();
    expect(securityEvent("a", row({ status: "vulnerable", findings: two }), row({ status: "vulnerable", findings: [two[0]] }))).toBeNull();
  });
  it("says so when the app is clean again", () => {
    expect(securityEvent("nova-wallet", row({ status: "vulnerable", findings: two }), row({ status: "ok", version: "16.4.0" }))).toEqual({
      kind: "ok", message: "nova-wallet no longer has known Next.js vulnerabilities (now 16.4.0)", detail: null,
    });
  });
  it("stays quiet for clean-to-clean, a failed check, or a version it can no longer read", () => {
    expect(securityEvent("a", row({ status: "ok" }), row({ status: "ok" }))).toBeNull();
    expect(securityEvent("a", null, row({ status: "ok" }))).toBeNull();
    expect(securityEvent("a", row({ status: "vulnerable", findings: two }), row({ status: "error", findings: two }))).toBeNull();
    expect(securityEvent("a", row({ status: "vulnerable", findings: two }), row({ status: "unknown", version: null }))).toBeNull();
  });
  it("follows a kept result: unknown keeps the findings, a re-read of the same ids is quiet, a real ok is the clean event", () => {
    const kept = row({ status: "unknown", reason: "version not exposed", findings: two });
    expect(securityEvent("a", row({ status: "vulnerable", findings: two }), kept)).toBeNull();
    expect(securityEvent("a", kept, row({ status: "vulnerable", findings: two }))).toBeNull();
    expect(securityEvent("a", kept, row({ status: "ok", version: "16.4.0" }))?.kind).toBe("ok");
  });
  it("keeps the detail short", () => {
    const many = Array.from({ length: 50 }, (_, i) => f(`GHSA-${"x".repeat(60)}-${i}`, "HIGH"));
    expect(securityEvent("a", null, row({ status: "vulnerable", findings: many }))!.detail!.length).toBeLessThanOrEqual(1000);
  });
});
