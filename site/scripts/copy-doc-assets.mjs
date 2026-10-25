// Runs before `next build` and `next dev`: copies the docs' images to public/docs-assets/ (git-ignored), where the
// rendered pages point (lib/docs.ts resolveDocLink).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyDocAssets, findDocsSource } from "../lib/docs-source.mjs";

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { docsDir } = findDocsSource(siteDir);
const copied = copyDocAssets(docsDir, path.join(siteDir, "public"));
console.log(`docs assets: ${copied.length} file(s) from ${path.relative(siteDir, docsDir)} to public/docs-assets`);
