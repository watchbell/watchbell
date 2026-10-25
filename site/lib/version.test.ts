import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findDocsSource } from "./docs-source.mjs";
import { FALLBACK_VERSION, releaseVersion, versionFromChangelog } from "./version";

describe("the version on the home page", () => {
  it("is the first release heading of the changelog", () => {
    expect(versionFromChangelog("# Changelog\n\nIntro.\n\n## 1.2.3\n\n### Fixes\n\n## 1.2.2\n")).toBe("1.2.3");
    expect(versionFromChangelog("# Changelog\n\n## v2.0.0 (21 Oct)\n")).toBe("2.0.0");
    expect(versionFromChangelog("# Changelog\n\n## Unreleased\n")).toBeNull();
  });

  it("comes from the real changelog next to the docs", () => {
    const changelog = fs.readFileSync(path.join(findDocsSource().repoRoot, "CHANGELOG.md"), "utf8");
    expect(releaseVersion()).toBe(versionFromChangelog(changelog));
  });

  it("falls back to a constant without a changelog", () => {
    const saved = process.env.WATCHBELL_DOCS_DIR;
    process.env.WATCHBELL_DOCS_DIR = path.join("no", "such", "docs");
    try {
      expect(releaseVersion()).toBe(FALLBACK_VERSION);
    } finally {
      if (saved === undefined) delete process.env.WATCHBELL_DOCS_DIR;
      else process.env.WATCHBELL_DOCS_DIR = saved;
    }
  });
});
