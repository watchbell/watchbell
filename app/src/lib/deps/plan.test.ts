import { describe, expect, it } from "vitest";
import type { FoundVuln } from "./osv";
import { findings } from "./osv";
import {
  alertLevel, alertMessage, countBySeverity, idsToRead, inRange, isRce, knownFindings, mergeDependabot, type OpenVuln, parseDependabot, planVulns, RESCAN_MS, RETRY_MS, scanDue, scanOrder,
  upgradesFor,
} from "./plan";

const now = new Date("2026-10-16T03:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const found = (o: Partial<FoundVuln> = {}): FoundVuln => ({
  package: "next", installedVersion: "15.0.0", vulnId: "GHSA-a", aliases: ["CVE-2025-1"], severity: "high", fixedVersion: "15.2.3", summary: "Bad", dev: false, source: "osv", ...o,
});
const open = (o: Partial<OpenVuln> = {}): OpenVuln => ({
  id: "row-1", package: "next", installedVersion: "15.0.0", vulnId: "GHSA-a", severity: "high", fixedVersion: "15.2.3", summary: "Bad", aliases: [], dev: false, direct: true, ...o,
});

describe("scanDue (the lockfile SHA cache)", () => {
  const row = { lockfileSha: "sha1", scannedAt: ago(3_600_000), queriedAt: ago(3_600_000), error: null };
  it("an unchanged lockfile queried within a week is not scanned again", () => {
    expect(scanDue(row, "sha1", now)).toBe(false);
  });
  it("a new SHA, no scan yet, a week old query, or a forced scan → scan", () => {
    expect(scanDue(row, "sha2", now)).toBe(true);
    expect(scanDue(null, "sha1", now)).toBe(true);
    expect(scanDue({ ...row, queriedAt: ago(RESCAN_MS) }, "sha1", now)).toBe(true);
    expect(scanDue(row, "sha1", now, true)).toBe(true);
  });
  it("a failed scan is retried after RETRY_MS (or at once when the lockfile changed)", () => {
    const failed = { ...row, error: "OSV.dev answered HTTP 503" };
    expect(scanDue(failed, "sha1", now)).toBe(false);
    expect(scanDue({ ...failed, scannedAt: ago(RETRY_MS) }, "sha1", now)).toBe(true);
    expect(scanDue(failed, "sha2", now)).toBe(true);
  });
  it("orders never-scanned first, then the oldest", () => {
    const list = [{ id: "b", scannedAt: ago(1000) }, { id: "c", scannedAt: null }, { id: "a", scannedAt: ago(5000) }];
    expect(scanOrder(list).map((r) => r.id)).toEqual(["c", "a", "b"]);
  });
});

describe("Dependabot", () => {
  const alert = (o: object = {}) => ({
    state: "open", dependency: { package: { ecosystem: "npm", name: "lodash" }, scope: "runtime" },
    security_advisory: { ghsa_id: "GHSA-lo", cve_id: "CVE-2021-23337", summary: "Command injection", severity: "high" },
    security_vulnerability: { severity: "high", vulnerable_version_range: "< 4.17.21", first_patched_version: { identifier: "4.17.21" } }, ...o,
  });
  it("parses open npm alerts; medium is moderate; other ecosystems and junk skipped; not a list → null", () => {
    expect(parseDependabot([alert(), alert({ state: "fixed" }), alert({ dependency: { package: { ecosystem: "pip", name: "x" } } }), 3])).toEqual([
      { package: "lodash", ghsaId: "GHSA-lo", cveId: "CVE-2021-23337", summary: "Command injection", severity: "high", range: "< 4.17.21", fixed: "4.17.21", dev: false },
    ]);
    expect(parseDependabot([alert({ security_vulnerability: { severity: "medium" }, dependency: { package: { ecosystem: "npm", name: "a" }, scope: "development" } })])?.[0])
      .toMatchObject({ severity: "moderate", dev: true, range: null, fixed: null });
    expect(parseDependabot({ message: "nope" })).toBeNull();
  });

  it("reads GitHub's ranges", () => {
    expect(inRange("4.17.20", "< 4.17.21")).toBe(true);
    expect(inRange("4.17.21", "< 4.17.21")).toBe(false);
    expect(inRange("13.2.0", ">= 13.0.0, < 13.5.4")).toBe(true);
    expect(inRange("12.0.0", ">= 13.0.0, < 13.5.4")).toBe(false);
    expect(inRange("2.0.0", "= 2.0.0")).toBe(true);
    expect(inRange("1.0.0", "garbage")).toBe(false);
    expect(inRange("1.0.0", "")).toBe(false);
  });

  it("adds only what OSV didn't report, at the installed versions the range holds", () => {
    const alerts = parseDependabot([alert(), alert({ security_advisory: { ghsa_id: "GHSA-a", cve_id: null, summary: "", severity: "high" }, dependency: { package: { ecosystem: "npm", name: "next" } } })])!;
    const deps = [{ name: "lodash", version: "4.17.20", dev: false }, { name: "lodash", version: "4.17.21", dev: false }];
    const out = mergeDependabot([found()], alerts, deps);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ package: "lodash", installedVersion: "4.17.20", vulnId: "GHSA-lo", aliases: ["CVE-2021-23337"], severity: "high", fixedVersion: "4.17.21", summary: "Command injection", dev: false, source: "dependabot" });
  });
});

describe("planVulns", () => {
  it("inserts new findings, updates the ones still there, resolves the ones gone; direct from the manifest", () => {
    const rows = [open(), open({ id: "row-2", package: "lodash", installedVersion: "4.17.20", vulnId: "GHSA-lo" })];
    const plan = planVulns(rows, [found({ severity: "critical" }), found({ package: "ws", installedVersion: "8.0.0", vulnId: "GHSA-ws" }), found()], new Set(["next"]));
    expect(plan.update).toEqual([{ id: "row-1", severity: "critical", fixedVersion: "15.2.3", summary: "Bad", aliases: ["CVE-2025-1"], dev: false, direct: true }]);
    expect(plan.insert.map((v) => [v.package, v.direct])).toEqual([["ws", false]]);
    expect(plan.resolve).toEqual(["row-2"]);
  });
});

describe("the app's alert", () => {
  it("critical for a critical advisory or remote code execution; warning for high; nothing below; dev-only never rings", () => {
    expect(alertLevel([{ severity: "critical", summary: "", dev: false }])).toBe("critical");
    expect(alertLevel([{ severity: "moderate", summary: "Remote Code Execution in x", dev: false }])).toBe("critical");
    expect(alertLevel([{ severity: "low", summary: "RCE via y", dev: false }])).toBe("critical");
    expect(alertLevel([{ severity: "high", summary: "", dev: false }, { severity: "low", summary: "", dev: false }])).toBe("warning");
    expect(alertLevel([{ severity: "moderate", summary: "", dev: false }])).toBeNull();
    expect(alertLevel([{ severity: "critical", summary: "", dev: true }])).toBeNull();
    expect(isRce("source code exposure")).toBe(false);
  });

  // Watchbell 1.2.1 (owner 1a): Moderate is treated like High, for a direct production dependency only.
  it("warning for a moderate advisory on a direct, non-dev dependency; never for a dev or transitive one, nor low/unknown", () => {
    expect(alertLevel([{ severity: "moderate", summary: "", dev: false, direct: true }])).toBe("warning");
    expect(alertLevel([{ severity: "moderate", summary: "", dev: true, direct: true }])).toBeNull();
    expect(alertLevel([{ severity: "moderate", summary: "", dev: false, direct: false }])).toBeNull();
    expect(alertLevel([{ severity: "low", summary: "", dev: false, direct: true }, { severity: "unknown", summary: "", dev: false, direct: true }])).toBeNull();
    expect(alertLevel([{ severity: "moderate", summary: "", dev: false, direct: true }, { severity: "critical", summary: "", dev: false, direct: false }])).toBe("critical");
    const msg = alertMessage([
      { package: "axios", installedVersion: "1.6.0", fixedVersion: "1.6.8", severity: "moderate", summary: "", dev: false, direct: true },
      { package: "vite", installedVersion: "5.0.0", fixedVersion: "5.0.1", severity: "moderate", summary: "", dev: true, direct: true },
      { package: "ws", installedVersion: "8.0.0", fixedVersion: "8.1.0", severity: "moderate", summary: "", dev: false, direct: false },
      { package: "next", installedVersion: "15.0.0", fixedVersion: "15.2.3", severity: "high", summary: "", dev: false, direct: true },
    ]);
    expect(msg).toBe("2 vulnerable packages (1 high, 1 moderate): next 15.0.0 → 15.2.3, axios 1.6.0 → 1.6.8.");
  });

  it("one message per app, grouping its ringing packages, worst first", () => {
    const vulns = [
      { package: "lodash", installedVersion: "4.17.20", fixedVersion: "4.17.21", severity: "high" as const, summary: "", dev: false },
      { package: "next", installedVersion: "15.0.0", fixedVersion: "15.2.3", severity: "critical" as const, summary: "", dev: false },
      { package: "next", installedVersion: "15.0.0", fixedVersion: "15.1.0", severity: "high" as const, summary: "", dev: false },
      { package: "ws", installedVersion: "8.0.0", fixedVersion: null, severity: "high" as const, summary: "", dev: false },
      { package: "vite", installedVersion: "5.0.0", fixedVersion: "5.0.1", severity: "critical" as const, summary: "", dev: true },
      { package: "tiny", installedVersion: "1.0.0", fixedVersion: "1.0.1", severity: "low" as const, summary: "", dev: false },
    ];
    expect(alertMessage(vulns)).toBe("3 vulnerable packages (1 critical, 3 high): next 15.0.0 → 15.2.3, lodash 4.17.20 → 4.17.21, next 15.0.0 → 15.1.0, ws 8.0.0 (no fix yet).");
    expect(countBySeverity(vulns)).toEqual({ critical: 2, high: 3, moderate: 0, low: 1, unknown: 0 });
    const many = Array.from({ length: 40 }, (_, i) => ({ package: `package-number-${i}`, installedVersion: "1.0.0", fixedVersion: "1.0.1", severity: "high" as const, summary: "", dev: false }));
    const m = alertMessage(many);
    expect(m.length).toBeLessThanOrEqual(300);
    expect(m).toContain("+36 more");
  });
});

describe("upgradesFor", () => {
  it("per direct package, the highest fix above the installed version; no fix or transitive → left out", () => {
    expect(upgradesFor([
      open({ fixedVersion: "15.1.0", vulnId: "GHSA-1", aliases: ["CVE-1"] }),
      open({ fixedVersion: "15.2.3", vulnId: "GHSA-2", severity: "critical" }),
      open({ package: "ws", fixedVersion: "8.1.0", direct: false }),
      open({ package: "zod", fixedVersion: null }),
      open({ package: "old", installedVersion: "2.0.0", fixedVersion: "1.0.0" }),
    ])).toEqual([{ package: "next", to: "15.2.3", vulnIds: ["GHSA-1", "GHSA-2"], cves: ["CVE-1"], severity: "critical" }]);
  });
});

describe("upgradesFor: devDependencies (fix round 1)", () => {
  it("marks a package whose every advisory row is a devDependency; one production copy keeps it unmarked", () => {
    expect(upgradesFor([open({ dev: true }), open({ vulnId: "GHSA-b", fixedVersion: "15.2.3", dev: true })])[0].dev).toBe(true);
    expect(upgradesFor([open({ dev: true }), open({ vulnId: "GHSA-b", fixedVersion: "15.2.3", dev: false })])[0].dev).toBeUndefined();
  });
});

describe("reusing stored advisories (fast re-scans)", () => {
  it("reuses OSV rows with a fix unless forced; rows without a fix or from Dependabot are read again", () => {
    const rows = [open(), open({ id: "r2", vulnId: "GHSA-nofix", fixedVersion: null }), { ...open({ id: "r3", vulnId: "GHSA-dep" }), source: "dependabot" as const }];
    expect([...knownFindings(rows, false).keys()]).toEqual(["next@15.0.0|GHSA-a"]);
    expect(knownFindings(rows, true).size).toBe(0);
  });

  it("reads only the ids some dependency still needs, and joins the known ones", () => {
    const known = knownFindings([open()], false);
    const deps = [{ name: "next", version: "15.0.0", dev: false }, { name: "next", version: "14.0.0", dev: true }];
    expect(idsToRead(deps, [["GHSA-a"], []], known)).toEqual([]);
    expect(idsToRead(deps, [["GHSA-a", "GHSA-b"], ["GHSA-a"]], known)).toEqual(["GHSA-b", "GHSA-a"]);
    expect(findings(deps, [["GHSA-a"], []], new Map(), known)).toEqual([{ package: "next", installedVersion: "15.0.0", vulnId: "GHSA-a", aliases: [], severity: "high", fixedVersion: "15.2.3", summary: "Bad", dev: false, source: "osv" }]);
  });
});
