import { describe, expect, it } from "vitest";
import { applyBumps, branchName, bumpRange, commitMessage, isOwnBranch, planBumps, prBody, prTitle } from "./bump";

const upgrade = (o = {}) => ({ package: "next", to: "15.2.3", vulnIds: ["GHSA-f82v-jwr5-mffw"], cves: ["CVE-2025-29927"], severity: "critical" as const, ...o });
const manifest = `{
    "name": "app",
    "dependencies": {
        "next": "^15.0.0",
        "react": "19.0.0"
    },
    "devDependencies": {
        "vite": "~5.0.0"
    }
}
`;

describe("bumpRange", () => {
  it("keeps the range's operator, refuses what it can't rewrite", () => {
    expect(bumpRange("^15.0.0", "15.2.3")).toBe("^15.2.3");
    expect(bumpRange("~5.0", "5.0.12")).toBe("~5.0.12");
    expect(bumpRange("19.0.0", "19.0.1")).toBe("19.0.1");
    expect(bumpRange(">=1.0.0", "1.2.0")).toBe(">=1.2.0");
    for (const r of ["latest", "workspace:*", "^1 || ^2", "github:a/b"]) expect(bumpRange(r, "2.0.0")).toBeNull();
    expect(bumpRange("^1.0.0", "not-a-version")).toBeNull();
  });
});

describe("planBumps / applyBumps", () => {
  it("bumps the listed ranges below the fix, in their own group", () => {
    const bumps = planBumps(manifest, [upgrade(), upgrade({ package: "vite", to: "5.0.12", vulnIds: ["GHSA-v"], cves: [] }), upgrade({ package: "lodash", to: "4.17.21" })])!;
    expect(bumps).toEqual([
      { package: "next", group: "dependencies", from: "^15.0.0", to: "^15.2.3", fixed: "15.2.3", vulnIds: ["GHSA-f82v-jwr5-mffw"], cves: ["CVE-2025-29927"] },
      { package: "vite", group: "devDependencies", from: "~5.0.0", to: "~5.0.12", fixed: "5.0.12", vulnIds: ["GHSA-v"], cves: [] },
    ]);
    const out = applyBumps(manifest, bumps)!;
    expect(out).toBe(manifest.replace('"^15.0.0"', '"^15.2.3"').replace('"~5.0.0"', '"~5.0.12"'));
  });

  it("a range that already starts at the fix, or a bad package.json, gives nothing", () => {
    expect(planBumps(manifest.replace("^15.0.0", "^15.2.3"), [upgrade()])).toEqual([]);
    expect(planBumps("not json", [upgrade()])).toBeNull();
    expect(planBumps("[]", [upgrade()])).toBeNull();
  });

  it("keeps CRLF and a missing final newline; refuses when the range changed meanwhile", () => {
    const crlf = '{\r\n  "dependencies": {\r\n    "next": "^15.0.0"\r\n  }\r\n}';
    const bumps = planBumps(crlf, [upgrade()])!;
    expect(applyBumps(crlf, bumps)).toBe(crlf.replace("^15.0.0", "^15.2.3"));
    expect(applyBumps(crlf.replace("^15.0.0", "^15.1.0"), bumps)).toBeNull();
  });
});

describe("branch and PR text", () => {
  const bumps = planBumps(manifest, [upgrade()])!;
  it("names the same branch for the same bumps, never the default branch", () => {
    const b = branchName(bumps);
    expect(b).toMatch(/^watchpost\/deps-[0-9a-f]{8}$/);
    expect(branchName([...bumps])).toBe(b);
    expect(isOwnBranch(b, "main")).toBe(true);
    expect(isOwnBranch("main", "main")).toBe(false);
    expect(isOwnBranch(b, b)).toBe(false);
    expect(isOwnBranch("watchpost/deps-x/../main", "main")).toBe(false);
  });

  it("writes the title, commit and body in English, with the npm install note", () => {
    expect(prTitle(bumps)).toBe("Watchbell: update next to 15.2.3 (security fix)");
    expect(commitMessage(bumps)).toBe("chore(deps): update next to 15.2.3 (security fix)");
    const two = planBumps(manifest, [upgrade(), upgrade({ package: "vite", to: "5.0.12" })])!;
    expect(prTitle(two)).toBe("Watchbell: update 2 vulnerable packages (next, vite)");
    const body = prBody(bumps, "pnpm");
    expect(body).toContain("| `next` | `^15.0.0` | `^15.2.3` | [CVE-2025-29927](https://osv.dev/vulnerability/CVE-2025-29927), [GHSA-f82v-jwr5-mffw]");
    expect(body).toContain("run `pnpm install`");
    expect(body).toContain("the lockfile is not updated");
    expect(prBody(bumps, null)).toContain("run `npm install`");
  });
});

// Watchbell 1.2.1 (review T1): a monorepo folder is part of the PR's identity and text; a package updated only to match
// next (eslint-config-next) isn't listed as vulnerable.
describe("per-folder PRs and companion packages", () => {
  const bumps = planBumps(manifest, [upgrade()])!;
  const eslint = { package: "eslint-config-next", to: "15.2.3", vulnIds: [], cves: [], severity: "critical" as const, companionOf: "next" };
  const withEslint = `{"dependencies":{"next":"^15.0.0"},"devDependencies":{"eslint-config-next":"15.0.0"}}`;

  it("the folder is in the branch key; a root PR keeps its old branch name", () => {
    expect(branchName(bumps)).toBe("watchpost/deps-ae170b17");
    expect(branchName(bumps, null)).toBe("watchpost/deps-ae170b17");
    const web = branchName(bumps, "apps/web");
    const admin = branchName(bumps, "apps/admin");
    expect(web).toMatch(/^watchpost\/deps-[0-9a-f]{8}$/);
    expect(new Set([branchName(bumps), web, admin]).size).toBe(3);
    expect(branchName([...bumps], "apps/web")).toBe(web);
  });

  it("the title, commit and body name the folder", () => {
    expect(prTitle(bumps, "apps/web")).toBe("Watchbell: update next to 15.2.3 in apps/web (security fix)");
    const two = planBumps(manifest, [upgrade(), upgrade({ package: "vite", to: "5.0.12" })])!;
    expect(prTitle(two, "apps/web")).toBe("Watchbell: update 2 vulnerable packages in apps/web (next, vite)");
    const body = prBody(bumps, "npm", false, "apps/web");
    expect(body).toContain("run `npm install` in `apps/web`");
    expect(prBody(bumps, "npm", true, "apps/web")).toContain("run `npm install` in `apps/web` on the main branch");
    expect(prBody(bumps, "npm")).not.toContain(" in `");
  });

  it("planBumps keeps companionOf; a companion is 'updated to match', not vulnerable, in the title and body", () => {
    const b = planBumps(withEslint, [upgrade({ to: "15.2.3" }), eslint])!;
    expect(b.map((x) => [x.package, x.companionOf ?? null])).toEqual([["next", null], ["eslint-config-next", "next"]]);
    expect(prTitle(b)).toBe("Watchbell: update next to 15.2.3 (security fix)");
    expect(commitMessage(b)).toBe("chore(deps): update next to 15.2.3 (security fix)");
    const body = prBody(b, "npm");
    const table = body.slice(body.indexOf("| Package"), body.indexOf("### Important"));
    expect(table).toContain("| `next` |");
    expect(table).not.toMatch(/\| `eslint-config-next` \|.*\| - \|/);
    expect(body).toContain("Updated to match next (no advisory of its own): `eslint-config-next` `15.0.0` → `15.2.3`.");
  });
});
