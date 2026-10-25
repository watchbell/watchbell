import { describe, expect, it } from "vitest";
import type { Finding } from "@/lib/security/types";
import { frameworkMessage, frameworkPlan, frameworkTarget, withCompanions } from "./framework";
import { cleanRootDir, dirText, inDir } from "./root-dir";

const f = (fixed: string | null, o: Partial<Finding> = {}): Finding => ({ id: `GHSA-${fixed ?? "none"}`, cve: null, summary: "", severity: "HIGH", fixed, ...o });

describe("frameworkTarget", () => {
  it("the smallest version that clears the advisories in the running major", () => {
    expect(frameworkTarget("16.3.8", [f("16.4.1")])).toBe("16.4.1");
    expect(frameworkTarget("16.3.8", [f("16.3.9"), f("16.4.1")])).toBe("16.4.1");
    // a fix in the same major wins over one that needs a major update
    expect(frameworkTarget("15.5.0", [f("15.5.7"), f("16.0.7")])).toBe("15.5.7");
  });

  it("a major update only when no fix is in the same major; null without a usable fix", () => {
    expect(frameworkTarget("14.2.0", [f("15.0.5")])).toBe("15.0.5");
    expect(frameworkTarget("16.3.8", [f(null)])).toBeNull();
    expect(frameworkTarget("16.4.1", [f("16.4.1")])).toBeNull();
    expect(frameworkTarget(null, [f("16.4.1")])).toBeNull();
    expect(frameworkTarget("canary", [f("16.4.1")])).toBeNull();
  });
});

describe("frameworkPlan", () => {
  it("next and eslint-config-next to the target, with the advisories and the worst severity", () => {
    const plan = frameworkPlan({ version: "16.3.8", status: "vulnerable", findings: [f("16.4.1", { id: "GHSA-a", cve: "CVE-2026-1", severity: "CRITICAL" }), f("16.3.9", { id: "GHSA-b" })] });
    expect(plan).toEqual({
      from: "16.3.8", to: "16.4.1",
      upgrades: [
        { package: "next", to: "16.4.1", vulnIds: ["GHSA-a", "GHSA-b"], cves: ["CVE-2026-1"], severity: "critical" },
        { package: "eslint-config-next", to: "16.4.1", vulnIds: [], cves: [], severity: "critical", companionOf: "next" },
      ],
      installed: new Map([["next", "16.3.8"], ["eslint-config-next", "16.3.8"]]),
    });
  });

  it("nothing for an app that isn't vulnerable or has no fix", () => {
    expect(frameworkPlan(null)).toBeNull();
    expect(frameworkPlan({ version: "16.4.1", status: "ok", findings: [] })).toBeNull();
    expect(frameworkPlan({ version: "16.3.8", status: "error", findings: [f("16.4.1")] })).toBeNull();
    expect(frameworkPlan({ version: "16.3.8", status: "vulnerable", findings: [f(null)] })).toBeNull();
  });

  it("the alert message names the version, the count, the worst severity and the version the update PR uses", () => {
    expect(frameworkMessage("16.3.8", [f("16.4.1", { severity: "CRITICAL" }), f("16.3.9")])).toBe("Next.js 16.3.8 has 2 known vulnerabilities (critical), fixed in 16.4.1.");
    expect(frameworkMessage(null, [f(null)])).toBe("Next.js (unknown version) has 1 known vulnerability (high), no fix yet.");
    // review T1 minor 6: the same-major target the proposal uses, and a plain note when some fixes need a higher major
    expect(frameworkMessage("15.5.0", [f("15.5.7"), f("16.0.7")])).toBe("Next.js 15.5.0 has 2 known vulnerabilities (high), fixed in 15.5.7 (one fix needs Next.js 16).");
    expect(frameworkMessage("15.5.0", [f("15.5.7"), f("16.0.7"), f("17.0.1")])).toBe("Next.js 15.5.0 has 3 known vulnerabilities (high), fixed in 15.5.7 (some fixes need Next.js 17).");
    // no fix in the running major: the major update is the target, nothing left over
    expect(frameworkMessage("14.2.0", [f("15.0.5")])).toBe("Next.js 14.2.0 has 1 known vulnerability (high), fixed in 15.0.5.");
  });
});

describe("cleanRootDir", () => {
  it("keeps a plain folder path and normalises Vercel's spellings", () => {
    expect(cleanRootDir("apps/web")).toBe("apps/web");
    expect(cleanRootDir("./apps/web/")).toBe("apps/web");
    expect(cleanRootDir("/apps/web")).toBe("apps/web");
    expect(cleanRootDir(" web ")).toBe("web");
  });

  it("the root and anything odd → null", () => {
    for (const v of [null, undefined, "", ".", "./", "/", 42, "../secrets", "apps/../..", "apps\\web", "a b", "a/b/c/d/e/f/g", "x".repeat(151)]) {
      expect(cleanRootDir(v), String(v)).toBeNull();
    }
  });

  it("paths and copy", () => {
    expect(inDir("apps/web", "package.json")).toBe("apps/web/package.json");
    expect(inDir(null, "package.json")).toBe("package.json");
    expect(dirText("apps/web")).toBe("apps/web (the Vercel project's Root Directory)");
    expect(dirText(null)).toBe("the repository root");
  });
});

// review T1 minor 8: the dependency scan's PR that updates next updates eslint-config-next with it (when listed).
describe("withCompanions", () => {
  const up = (pkg: string, to: string) => ({ package: pkg, to, vulnIds: [`GHSA-${pkg}`], cves: [], severity: "high" as const });
  it("adds eslint-config-next at next's version, marked as a companion", () => {
    expect(withCompanions([up("next", "15.2.3"), up("lodash", "4.17.21")])).toEqual([
      up("next", "15.2.3"), up("lodash", "4.17.21"), { package: "eslint-config-next", to: "15.2.3", vulnIds: [], cves: [], severity: "high", companionOf: "next" },
    ]);
  });
  it("unchanged without next, or when eslint-config-next has its own upgrade", () => {
    expect(withCompanions([up("lodash", "4.17.21")])).toEqual([up("lodash", "4.17.21")]);
    expect(withCompanions([up("next", "15.2.3"), up("eslint-config-next", "15.2.4")])).toEqual([up("next", "15.2.3"), up("eslint-config-next", "15.2.4")]);
  });
});
