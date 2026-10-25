import type { LockKind } from "./lockfile";

// Watchbell 1.2 (owner 23 Oct): a Vercel project's Root Directory (resources.meta.rootDirectory, written by the account
// sync) is where its package.json lives in a monorepo ("apps/web"). The dependency scan and the update PR read and
// write <rootDirectory>/package.json and its lockfile there. Pure.

const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_LEN = 150;
// The same depth the GitHub Actions lockfile hand-off accepts (actions-lockfile.ts LOCK_PATH and its workflow: 4
// folders), so a folder the scan and the PR use always gets its lockfile updated too.
const MAX_DEPTH = 4;
const SHOWN_MAX = 80;

const parts = (v: string): string[] => v.trim().replace(/^\.\//, "").split("/").filter((p) => p !== "" && p !== ".");

// What Vercel stores ("apps/web", "./apps/web/", "/apps/web", "" or null) → "apps/web", or null for the repository root.
// Anything that could leave the repository or isn't a plain folder path ("..", backslashes, odd characters, too long or
// too deep) → null, so the scan falls back to the root instead of reading somewhere unexpected.
export function cleanRootDir(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const p = parts(v);
  if (!p.length) return null;
  if (p.length > MAX_DEPTH || p.some((x) => x === ".." || !SEGMENT.test(x))) return null;
  const dir = p.join("/");
  return dir.length <= MAX_LEN ? dir : null;
}

// Watchbell 1.2.1 (review T1): a Root Directory Vercel has that cleanRootDir refuses ("my app", "@scope/web", too
// deep): its text for the Dependencies card and the PR refusal (control characters dropped, clipped), so the scan of the
// root isn't mistaken for the app's folder. Null for the root and for a folder that can be used.
export function unusableRootDir(v: unknown): string | null {
  if (typeof v !== "string" || !parts(v).length || cleanRootDir(v) !== null) return null;
  const shown = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (!shown) return null;
  return shown.length > SHOWN_MAX ? `${shown.slice(0, SHOWN_MAX - 1)}…` : shown;
}

// A file inside the folder (or the root when dir is null).
export const inDir = (dir: string | null, file: string): string => (dir ? `${dir}/${file}` : file);

// "apps/web" → "apps/web (the Vercel project's Root Directory)", null → "the repository root".
export const dirText = (dir: string | null): string => (dir ? `${dir} (the Vercel project's Root Directory)` : "the repository root");

// ---- is the repository root a workspace that includes the folder? (Watchbell 1.2.1, review T1) ----
// Only then does the root's lockfile describe the folder's packages. A root package.json for something else (Firebase
// functions, tooling) has a lockfile without them, so the scan reads the folder's package.json ranges instead.

const normGlob = (g: string): string => g.trim().replace(/^\.\//, "").replace(/\/+$/, "");
function globRe(g: string): RegExp {
  const src = normGlob(g).split("**").map((s) => s.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*");
  return new RegExp(`^${src}$`);
}

// The root package.json's "workspaces" (an array, or { packages: [...] } as yarn writes it) lists a glob that matches
// the folder and no "!glob" excludes it.
export function workspaceCovers(rootManifest: string | null, dir: string): boolean {
  if (!rootManifest) return false;
  let j: unknown;
  try {
    j = JSON.parse(rootManifest);
  } catch {
    return false;
  }
  const ws = j && typeof j === "object" && !Array.isArray(j) ? (j as { workspaces?: unknown }).workspaces : undefined;
  const list = Array.isArray(ws) ? ws : ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages) ? (ws as { packages: unknown[] }).packages : [];
  const globs = list.filter((g): g is string => typeof g === "string" && g.trim() !== "");
  const neg = globs.filter((g) => g.trim().startsWith("!")).map((g) => g.trim().slice(1));
  return globs.some((g) => !g.trim().startsWith("!") && globRe(g).test(dir)) && !neg.some((g) => globRe(g).test(dir));
}

// The root lockfile itself names the folder as a workspace: npm (v2/v3) has packages["apps/web"], pnpm has an
// importers entry "apps/web:". Yarn and bun lockfiles don't say; the root package.json decides for them.
export function lockCoversDir(kind: Exclude<LockKind, "package-json">, text: string, dir: string): boolean {
  if (kind === "npm") {
    try {
      const j = JSON.parse(text) as { packages?: unknown };
      return !!j.packages && typeof j.packages === "object" && Object.hasOwn(j.packages, dir);
    } catch {
      return false;
    }
  }
  if (kind === "pnpm") {
    const at = text.search(/^importers:\s*$/m);
    if (at < 0) return false;
    const block = text.slice(at).split(/\n(?=\S)/)[0];
    const esc = dir.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^ {2}['"]?${esc}['"]?:\\s*$`, "m").test(block);
  }
  return false;
}
