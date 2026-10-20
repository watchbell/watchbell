import { describe, expect, it } from "vitest";
import { autoPick, effectiveDeps, installedOf, overlappingPr, prPackages, sameMajor, STALE_NOTE } from "./auto-policy";
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
