import { describe, expect, it } from "vitest";
import { autoPick, effectiveDeps, installedOf, overlappingPr, prDir, prPackages, sameMajor, STALE_NOTE } from "./auto-policy";
import type { Upgrade } from "./plan";

const up = (o: Partial<Upgrade>): Upgrade => ({ package: "next", to: "15.0.5", vulnIds: ["GHSA-x"], cves: [], severity: "critical", ...o });

describe("sameMajor", () => {
  it.each([
    ["15.0.0", "15.0.5", true], ["15.0.0", "15.3.1", true], ["15.9.0", "16.0.0", false], ["1.2.3", "1.2.3", true],
    ["0.4.1", "0.4.9", true], ["0.4.1", "0.5.0", false], ["0.0.3", "0.0.4", true], ["0.0.3", "0.1.0", false],
    ["2.0.0-beta.1", "2.0.0", true], ["2.0.0", "2.1.0-rc.1", true], ["1.9.9", "2.0.0-rc.1", false],
    ["15.0.5", "15.0.0", false], ["v4.17.20", "4.17.21", true], ["latest", "1.0.0", false], ["1.2", "1.2.5", false],
  ])("%s → %s: %s", (a, b, want) => expect(sameMajor(a, b)).toBe(want));
});

describe("autoPick", () => {
  const installed = new Map([["next", "15.0.0"], ["lodash", "4.17.0"], ["axios", "0.27.0"]]);
  it("keeps the upgrades at the chosen severities, all in their major", () => {
    const r = autoPick([up({}), up({ package: "lodash", to: "4.17.21", severity: "high" }), up({ package: "axios", to: "1.6.0", severity: "moderate" })], installed, ["critical", "high"]);
    expect(r).toEqual({ ok: true, upgrades: [up({}), up({ package: "lodash", to: "4.17.21", severity: "high" })] });
  });
  it("severity filter: only critical when the owner chose only critical", () => {
    expect(autoPick([up({ severity: "high" })], installed, ["critical"])).toEqual({ ok: false, why: "severity" });
    expect(autoPick([up({ severity: "moderate" })], installed, ["critical", "high"])).toEqual({ ok: false, why: "severity" });
  });
  // Watchbell 1.2.1 (owner 1a): Moderate like High, when the owner has it switched on (the default).
  it("picks a moderate upgrade when moderate is chosen, and not when it isn't", () => {
    const mod = up({ package: "lodash", to: "4.17.21", severity: "moderate" });
    expect(autoPick([mod], installed, ["critical", "high", "moderate"])).toEqual({ ok: true, upgrades: [mod] });
    expect(autoPick([up({}), mod], installed, ["critical", "high", "moderate"])).toEqual({ ok: true, upgrades: [up({}), mod] });
    expect(autoPick([mod], installed, ["critical", "high"])).toEqual({ ok: false, why: "severity" });
    expect(autoPick([up({ severity: "low" }), up({ package: "lodash", to: "4.17.21", severity: "unknown" })], installed, ["critical", "high", "moderate"])).toEqual({ ok: false, why: "severity" });
  });
  // Fix round 1 (review minor 7): Moderate counts for direct production dependencies only, in the alert and here.
  it("never picks a moderate devDependency, even with Moderate on; a high one still follows the High switch", () => {
    const devMod = up({ package: "lodash", to: "4.17.21", severity: "moderate", dev: true });
    expect(autoPick([devMod], installed, ["critical", "high", "moderate"])).toEqual({ ok: false, why: "severity" });
    expect(autoPick([up({}), devMod], installed, ["critical", "high", "moderate"])).toEqual({ ok: true, upgrades: [up({})] });
    const devHigh = up({ package: "lodash", to: "4.17.21", severity: "high", dev: true });
    expect(autoPick([devHigh], installed, ["high"])).toEqual({ ok: true, upgrades: [devHigh] });
  });
  it("a major (or 0.x minor) jump among the picked ones → waits for the owner", () => {
    expect(autoPick([up({ to: "16.0.1" })], installed, ["critical"])).toEqual({ ok: false, why: "major" });
    expect(autoPick([up({ package: "axios", to: "0.28.0", severity: "high" })], installed, ["high"])).toEqual({ ok: false, why: "major" });
    expect(autoPick([up({ package: "unknown" })], installed, ["critical"])).toEqual({ ok: false, why: "major" });
    expect(autoPick([], installed, ["critical"])).toEqual({ ok: false, why: "nothing" });
  });
  it("direct only: the installed version comes from direct rows", () => {
    const m = installedOf([
      { package: "next", installedVersion: "15.0.2", direct: true }, { package: "next", installedVersion: "15.0.0", direct: true },
      { package: "minimist", installedVersion: "1.2.0", direct: false },
    ]);
    expect([...m]).toEqual([["next", "15.0.0"]]);
    expect(autoPick([up({ package: "minimist", to: "1.2.8" })], m, ["critical"])).toEqual({ ok: false, why: "major" });
  });
});

describe("open PR dedupe", () => {
  const pr = (o: object) => ({ number: 7, branch: "watchpost/deps-0a1b2c3d", title: "Watchpost: update 2 vulnerable packages (next, lodash)", packages: null, ...o });
  it("knows a PR's packages from what we stored, else its title; an unknown multi-package one blocks all", () => {
    expect(prPackages(pr({ packages: ["next", "lodash"] }))).toEqual(["next", "lodash"]);
    expect(prPackages(pr({ title: "Watchpost: update next ke 15.0.5 (perbaikan keamanan)" }))).toEqual(["next"]); // opened before the rename
    expect(prPackages(pr({ title: "Watchbell: update next to 15.0.5 (security fix)" }))).toEqual(["next"]);
    expect(prPackages(pr({}))).toBe("all");
  });
  it("finds the open PR covering a package", () => {
    const open = [pr({ number: 3, packages: ["lodash"] }), pr({ number: 4, title: "Watchpost: update next ke 15.0.5 (perbaikan keamanan)" })];
    expect(overlappingPr(["next"], open)?.number).toBe(4);
    expect(overlappingPr(["axios"], open)).toBeNull();
    expect(overlappingPr(["axios"], [pr({})])?.number).toBe(7);
    expect(overlappingPr(["next"], [])).toBeNull();
  });
});

describe("effectiveDeps (stale lockfile)", () => {
  const manifest = { dependencies: { next: "16.3.8", react: "^19.0.0" }, devDependencies: { vitest: "^3.0.0" }, optionalDependencies: {} };
  it("a direct package whose range no longer allows the lockfile's version is read at the range's minimum", () => {
    const r = effectiveDeps([
      { name: "next", version: "16.2.10", dev: false }, { name: "react", version: "19.1.0", dev: false }, { name: "vitest", version: "2.1.0", dev: true },
      { name: "lodash", version: "4.17.0", dev: false },
    ], manifest);
    expect(r.stale).toEqual(["next", "vitest"]);
    expect(r.deps).toEqual(expect.arrayContaining([{ name: "next", version: "16.3.8", dev: false }, { name: "vitest", version: "3.0.0", dev: true }, { name: "react", version: "19.1.0", dev: false }, { name: "lodash", version: "4.17.0", dev: false }]));
    expect(r.deps.filter((d) => d.name === "next")).toHaveLength(1);
  });
  it("leaves it when any copy satisfies the range, or there is no manifest", () => {
    const deps = [{ name: "next", version: "16.2.10", dev: false }, { name: "next", version: "16.3.9", dev: false }];
    expect(effectiveDeps(deps, manifest).stale).toEqual([]);
    expect(effectiveDeps(deps, null)).toEqual({ deps, stale: [] });
    expect(STALE_NOTE(["next"])).toBe("Lockfile tertinggal — jalankan npm install (next).");
  });
});

// Watchbell 1.2.1 (review T1): two apps of one repository in different folders each get their own PR.
describe("prDir / overlappingPr per folder", () => {
  const pr = (title: string, packages: string[] | null = null) => ({ number: 4, branch: "watchpost/deps-0a0b0c0d", title, packages });
  it("reads the folder from a Watchbell title; older and root titles are the root", () => {
    expect(prDir("Watchbell: update next to 16.4.1 in apps/web (security fix)")).toBe("apps/web");
    expect(prDir("Watchbell: update 2 vulnerable packages in apps/admin (next, vite)")).toBe("apps/admin");
    expect(prDir("Watchbell: update next to 16.4.1 (security fix)")).toBeNull();
    expect(prDir("Watchbell: update 2 vulnerable packages (next, vite)")).toBeNull();
    expect(prDir("Watchpost: update next ke 15.1.0 (perbaikan keamanan)")).toBeNull();
    expect(prDir("Bump next in apps/web (manual)")).toBeNull();
  });

  it("only a PR of the same folder overlaps", () => {
    const web = pr("Watchbell: update next to 16.4.1 in apps/web (security fix)", ["next", "eslint-config-next"]);
    expect(overlappingPr(["next"], [web], "apps/admin")).toBeNull();
    expect(overlappingPr(["next"], [web], "apps/web")?.number).toBe(4);
    expect(overlappingPr(["next"], [web], null)).toBeNull();
    const root = pr("Watchbell: update next to 16.4.1 (security fix)");
    expect(overlappingPr(["next"], [root])?.number).toBe(4);
    expect(overlappingPr(["next"], [root], "apps/web")).toBeNull();
  });
});
