// Where the documentation lives, and the copy of its images into public/. Plain JavaScript so the prebuild script
// (scripts/copy-doc-assets.mjs) and the site (lib/docs.ts) share it.
//
// The private tree keeps the public pages in public-edition/docs; the exported public repository has them in docs/.
// Either way the site sits next to them in site/. WATCHBELL_DOCS_DIR overrides both (tests, or a build that must show
// the "translation coming" pages).

import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} [siteDir] the site folder (default: the current directory, which `next build` sets to site/)
 * @returns {{ docsDir: string, idDir: string, repoRoot: string }}
 */
export function findDocsSource(siteDir = process.cwd()) {
  const fromEnv = process.env.WATCHBELL_DOCS_DIR;
  const candidates = fromEnv
    ? [path.resolve(siteDir, fromEnv)]
    : [path.resolve(siteDir, "..", "public-edition", "docs"), path.resolve(siteDir, "..", "docs")];
  for (const docsDir of candidates) {
    if (fs.existsSync(path.join(docsDir, "README.md"))) {
      return { docsDir, idDir: path.join(docsDir, "id"), repoRoot: path.dirname(docsDir) };
    }
  }
  throw new Error(`Documentation not found (looked for README.md in ${candidates.join(", ")})`);
}

/** Where a docs file that isn't a page (an image) is served from: docs/images/x.png → /docs-assets/images/x.png. */
export const ASSET_PREFIX = "/docs-assets";

/**
 * Copies every file under docsDir that isn't Markdown (images and the like) to `<publicDir>/docs-assets/`, keeping the
 * folders, after emptying that folder. Returns the copied paths relative to docsDir ("/" separators).
 * @param {string} docsDir
 * @param {string} publicDir
 * @returns {string[]}
 */
export function copyDocAssets(docsDir, publicDir) {
  const target = path.join(publicDir, ASSET_PREFIX.slice(1));
  fs.rmSync(target, { recursive: true, force: true });
  /** @type {string[]} */
  const copied = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(from);
      else if (entry.isFile() && !entry.name.toLowerCase().endsWith(".md")) {
        const rel = path.relative(docsDir, from);
        fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
        fs.copyFileSync(from, path.join(target, rel));
        copied.push(rel.split(path.sep).join("/"));
      }
    }
  };
  walk(docsDir);
  return copied.sort();
}
