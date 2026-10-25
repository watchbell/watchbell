import fs from "node:fs";
import path from "node:path";
import { findDocsSource } from "./docs-source.mjs";

/** Shown when the changelog can't be read (a test docs folder, or a build without it). */
export const FALLBACK_VERSION = "1.1.0";

/** The newest release in a changelog: its first "## x.y.z" heading, or null when there is none. */
export function versionFromChangelog(text: string): string | null {
  const m = /^##\s+v?(\d+\.\d+\.\d+)\b/m.exec(text);
  return m ? m[1] : null;
}

/**
 * The current Watchbell version, read at build time from the CHANGELOG.md next to the docs (public-edition/CHANGELOG.md
 * in the private tree, CHANGELOG.md at the root of the public repository), so the home page's terminal sample follows
 * each release without an edit.
 */
export function releaseVersion(): string {
  try {
    const { repoRoot } = findDocsSource();
    return versionFromChangelog(fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8")) ?? FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}
