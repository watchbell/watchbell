import { describe, expect, it } from "vitest";
import { lockfilePayload } from "./actions-lockfile";
import { cleanRootDir, inDir, lockCoversDir, unusableRootDir, workspaceCovers } from "./root-dir";

// Watchbell 1.2.1 (review T1): the Root Directory's limits, the value that couldn't be used, and the workspace check.
describe("cleanRootDir depth", () => {
  it("allows the depth the lockfile hand-off accepts (4 folders), not deeper", () => {
    expect(cleanRootDir("a/b/c/d")).toBe("a/b/c/d");
    expect(cleanRootDir("a/b/c/d/e")).toBeNull();
    for (const dir of ["web", "apps/web", "a/b/c", "a/b/c/d"]) {
      expect(lockfilePayload({ repo: "acme/shop", branch: "watchpost/deps-0a1b2c3d", lockfilePath: inDir(cleanRootDir(dir), "package-lock.json"), prNumber: 3 }), dir).not.toBeNull();
    }
  });
});

describe("unusableRootDir", () => {
  it("a Root Directory Vercel has but Watchbell can't use → its text, for the card and the PR refusal", () => {
    expect(unusableRootDir("my app")).toBe("my app");
    expect(unusableRootDir("@scope/web")).toBe("@scope/web");
    expect(unusableRootDir("../x")).toBe("../x");
    expect(unusableRootDir("a/b/c/d/e")).toBe("a/b/c/d/e");
    expect(unusableRootDir("apps/wéb")).toBe("apps/wéb");
  });

  it("nothing for the root, a usable folder or a non-string; control characters dropped and the text clipped", () => {
    for (const v of [null, undefined, "", "  ", ".", "./", "/", "apps/web", "./apps/web/", 42]) expect(unusableRootDir(v), String(v)).toBeNull();
    expect(unusableRootDir("a\u0000b\nc d")).toBe("abc d");
    expect(unusableRootDir(`${"x ".repeat(60)}`)?.length).toBeLessThanOrEqual(80);
  });
});

describe("workspaceCovers (the root package.json's workspaces)", () => {
  const root = (workspaces: unknown) => JSON.stringify({ name: "root", private: true, workspaces });
  it("an array or { packages } of globs that matches the folder", () => {
    expect(workspaceCovers(root(["apps/*"]), "apps/web")).toBe(true);
    expect(workspaceCovers(root(["apps/web"]), "apps/web")).toBe(true);
    expect(workspaceCovers(root(["./apps/web/"]), "apps/web")).toBe(true);
    expect(workspaceCovers(root({ packages: ["packages/**"] }), "packages/ui/web")).toBe(true);
    expect(workspaceCovers(root(["apps/*"]), "apps/web/sub")).toBe(false);
    expect(workspaceCovers(root(["packages/*"]), "apps/web")).toBe(false);
    expect(workspaceCovers(root(["apps/*", "!apps/web"]), "apps/web")).toBe(false);
  });

  it("no workspaces, or a package.json that can't be read → false", () => {
    expect(workspaceCovers(JSON.stringify({ name: "functions", dependencies: { "firebase-admin": "^12.0.0" } }), "apps/web")).toBe(false);
    expect(workspaceCovers("not json", "apps/web")).toBe(false);
    expect(workspaceCovers(root("apps/*"), "apps/web")).toBe(false);
    expect(workspaceCovers(null, "apps/web")).toBe(false);
  });
});

describe("lockCoversDir (the root lockfile lists the folder)", () => {
  it("npm v2/v3: packages[folder]; pnpm: importers[folder]", () => {
    const npm = (packages: Record<string, unknown>) => JSON.stringify({ lockfileVersion: 3, packages });
    expect(lockCoversDir("npm", npm({ "": {}, "apps/web": { name: "web" }, "node_modules/next": { version: "16.3.8" } }), "apps/web")).toBe(true);
    expect(lockCoversDir("npm", npm({ "": {}, "node_modules/firebase-admin": { version: "12.0.0" } }), "apps/web")).toBe(false);
    expect(lockCoversDir("npm", "{", "apps/web")).toBe(false);
    const pnpm = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    {}\n\n  apps/web:\n    dependencies:\n      next:\n        specifier: ^16.3.8\n";
    expect(lockCoversDir("pnpm", pnpm, "apps/web")).toBe(true);
    expect(lockCoversDir("pnpm", pnpm, "apps/admin")).toBe(false);
    expect(lockCoversDir("pnpm", "lockfileVersion: '9.0'\npackages:\n  apps/web:\n", "apps/web")).toBe(false);
  });

  it("yarn and bun lockfiles don't say: the root package.json decides", () => {
    expect(lockCoversDir("yarn", "# yarn lockfile v1\n", "apps/web")).toBe(false);
    expect(lockCoversDir("bun", "{}", "apps/web")).toBe(false);
  });
});
