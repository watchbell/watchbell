// Reads the deployed Next.js version from a live site, without a token. Pure: the caller fetches, this only parses.
// Next's client runtime sets `window.next = { version: "x.y.z", ... }` (app-index for the App Router, client/index for
// the Pages Router), so the version sits in one of the page's /_next/static scripts. Nothing here guesses: a version
// string is only taken when it is the one assigned to `next`, or sits beside `appDir` in the same object literal.
// Only script files are read: the page HTML can show Next.js code samples (a blog, a portfolio).

const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?`;
const Q = "[\"'`]";

export function isNextVersion(v: string): boolean {
  const m = /^(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.exec(v);
  return m !== null && Number(m[1]) >= 9 && Number(m[1]) < 1000;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#x27;": "'", "&#x2F;": "/", "&#47;": "/" };
const decode = (s: string) => s.replace(/&(?:amp|quot|#39|#x27|#x2F|#47);/gi, (e) => ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? e);

// Likely runtime files first (main-app for the App Router, main for the Pages Router), page order otherwise, and the
// webpack runtime, polyfills and React's framework chunk last, since they never hold the version.
function rank(path: string): number {
  if (/\/main-app[-.]/.test(path)) return 0;
  if (/\/(main|app-index)[-.]/.test(path)) return 1;
  if (/\/(webpack|polyfills|framework)[-.]/.test(path)) return 3;
  return 2;
}

// <script src> addresses under /_next/static/ on the page's own origin. The caller has already checked that the page
// stayed on the app's host.
export function nextScriptUrls(html: string, pageUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: { href: string; rank: number; i: number }[] = [];
  for (const m of html.matchAll(/<script\b[^>]*?\ssrc\s*=\s*(["'])(.*?)\1/gi)) {
    let u: URL;
    try {
      u = new URL(decode(m[2].trim()), base);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" || u.origin !== base.origin || !u.pathname.startsWith("/_next/static/")) continue;
    u.hash = "";
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    out.push({ href: u.href, rank: rank(u.pathname), i: out.length });
  }
  return out.sort((a, b) => a.rank - b.rank || a.i - b.i).map((x) => x.href);
}

const DIRECT = new RegExp(String.raw`\bnext\s*=\s*\{\s*version\s*:\s*${Q}(${SEMVER})${Q}`, "g");
// version and appDir side by side in one object literal, either order: {version:"15.1.0",appDir:!0} / {appDir:!0,version:…}
const VERSION_APPDIR = new RegExp(String.raw`version\s*:\s*${Q}(${SEMVER})${Q}\s*,\s*appDir\s*:`, "g");
const APPDIR_VERSION = new RegExp(String.raw`appDir\s*:\s*[^,{}()]{1,16},\s*version\s*:\s*${Q}(${SEMVER})${Q}`, "g");
const BY_NAME = /\bnext\s*=\s*\{\s*version\s*(?::\s*([A-Za-z_$][\w$]*)\s*)?[,}]/g;
const escape = (s: string) => s.replace(/[$]/g, "\\$");

export function extractNextVersion(js: string): string | null {
  // 1. window.next={version:"15.1.0",appDir:!0} (also self.next, globalThis.next, a minified alias)
  for (const m of js.matchAll(DIRECT)) if (isNextVersion(m[1])) return m[1];
  // 2. version:"15.1.0" beside appDir in the same literal (React's own version:"19.x" never is)
  for (const re of [VERSION_APPDIR, APPDIR_VERSION]) for (const m of js.matchAll(re)) if (isNextVersion(m[1])) return m[1];
  // 3. Pages Router: window.next={version:Y,router:…} with Y="14.2.3". Minified names are reused across modules, so
  //    only the last definition before the assignment counts.
  for (const m of js.matchAll(BY_NAME)) {
    const name = m[1] ?? "version";
    const def = new RegExp(String.raw`(?:^|[^\w$.])${escape(name)}\s*=\s*${Q}(${SEMVER})${Q}`, "g");
    let found: string | null = null;
    for (const d of js.matchAll(def)) {
      if ((d.index ?? 0) >= (m.index ?? 0)) break;
      found = d[1];
    }
    if (found && isNextVersion(found)) return found;
  }
  return null;
}
