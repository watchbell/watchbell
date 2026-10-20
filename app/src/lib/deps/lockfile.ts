// Stage 9 slice 5 (owner 16 Oct): which npm packages, at which versions, a repository installs. Pure: the text of a
// lockfile (or package.json) in, a deduplicated package list out. Supported: package-lock.json / npm-shrinkwrap.json
// (v1, v2, v3), pnpm-lock.yaml (v5, v6, v9), yarn.lock (classic v1 and berry), bun.lock (the text format; bun.lockb is
// binary and not read). Without a lockfile, package.json's ranges give an approximate list (the lowest version each
// simple range allows). Nothing here throws: an unreadable file is null.

export type Dep = { name: string; version: string; dev: boolean };
export type LockKind = "npm" | "pnpm" | "yarn" | "bun" | "package-json";
export type Parsed = { kind: LockKind; deps: Dep[]; approximate: boolean };

// Root files tried in this order: the first that exists is the lockfile.
export const LOCKFILES: { path: string; kind: Exclude<LockKind, "package-json"> }[] = [
  { path: "package-lock.json", kind: "npm" },
  { path: "npm-shrinkwrap.json", kind: "npm" },
  { path: "pnpm-lock.yaml", kind: "pnpm" },
  { path: "yarn.lock", kind: "yarn" },
  { path: "bun.lock", kind: "bun" },
];

export const MAX_DEPS = 10_000;
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9._~-][a-z0-9._~-]*$/i;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const isPackageName = (v: string): boolean => v.length <= 214 && NAME.test(v);
export const isVersion = (v: string): boolean => v.length <= 100 && VERSION.test(v);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// One entry per name@version; dev only when every occurrence is dev.
function collect(list: Dep[]): Dep[] {
  const by = new Map<string, Dep>();
  for (const d of list) {
    if (!isPackageName(d.name) || !isVersion(d.version)) continue;
    const k = `${d.name}@${d.version}`;
    const had = by.get(k);
    if (had) had.dev = had.dev && d.dev;
    else by.set(k, { ...d });
    if (by.size >= MAX_DEPS) break;
  }
  return [...by.values()].sort((a, b) => (a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// "node_modules/a/node_modules/@s/b" → "@s/b"
const nameFromPath = (path: string): string | null => {
  const i = path.lastIndexOf("node_modules/");
  return i < 0 ? null : path.slice(i + "node_modules/".length) || null;
};

export function parsePackageLock(text: string): Dep[] | null {
  const j = parseJson(text);
  if (!isObj(j)) return null;
  const out: Dep[] = [];
  if (isObj(j.packages)) {
    // v2 / v3: a flat map keyed by install path. Links (workspaces) and the root have no registry version.
    for (const [path, v] of Object.entries(j.packages)) {
      if (!path || !isObj(v) || v.link === true || typeof v.version !== "string") continue;
      const name = typeof v.name === "string" && path.includes("node_modules/") ? v.name : nameFromPath(path);
      if (!name) continue;
      out.push({ name, version: v.version, dev: v.dev === true });
    }
    return collect(out);
  }
  if (isObj(j.dependencies)) {
    // v1: a nested tree.
    const walk = (deps: Obj, depth: number) => {
      if (depth > 40) return;
      for (const [name, v] of Object.entries(deps)) {
        if (!isObj(v)) continue;
        if (typeof v.version === "string") out.push({ name, version: v.version, dev: v.dev === true });
        if (isObj(v.dependencies)) walk(v.dependencies, depth + 1);
      }
    };
    walk(j.dependencies, 0);
    return collect(out);
  }
  return null;
}

const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, "");

// A pnpm package key → name and version. v9 "next@16.0.0", v6 "/next@14.0.0(react@18.2.0)", v5 "/next/12.0.0_react@17".
export function pnpmKey(raw: string): { name: string; version: string } | null {
  let k = unquote(raw).replace(/^\//, "");
  const paren = k.indexOf("(");
  if (paren > 0) k = k.slice(0, paren);
  const at = k.lastIndexOf("@");
  if (at > 0 && !k.slice(at + 1).includes("/") && isPackageName(k.slice(0, at))) {
    return { name: k.slice(0, at), version: k.slice(at + 1).split("_")[0] };
  }
  const slash = k.lastIndexOf("/");
  if (slash <= 0) return null;
  return { name: k.slice(0, slash), version: k.slice(slash + 1).split("_")[0] };
}

export function parsePnpmLock(text: string): Dep[] | null {
  const lines = text.split(/\r?\n/);
  if (!lines.some((l) => /^lockfileVersion:/.test(l))) return null;
  const out: Dep[] = [];
  let inPackages = false;
  let current: Dep | null = null;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inPackages = /^packages:\s*$/.test(line);
      current = null;
      continue;
    }
    if (!inPackages) continue;
    const key = /^ {2}(\S.*?):\s*$/.exec(line);
    if (key) {
      const p = pnpmKey(key[1]);
      current = p ? { ...p, dev: false } : null;
      if (current) out.push(current);
      continue;
    }
    if (current && /^ {4}dev: true\s*$/.test(line)) current.dev = true;
  }
  return collect(out);
}

// "@s/x@^1.0.0" or "x@npm:^1.0.0" → the package name.
function yarnName(descriptor: string): string | null {
  const d = unquote(descriptor);
  const at = d.indexOf("@", d.startsWith("@") ? 1 : 0);
  return at > 0 ? d.slice(0, at) : null;
}

export function parseYarnLock(text: string): Dep[] | null {
  const lines = text.split(/\r?\n/);
  const out: Dep[] = [];
  let name: string | null = null;
  let seenHeader = false;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\S/.test(line)) {
      const header = line.replace(/:\s*$/, "");
      // Workspaces and local links aren't registry packages (berry: "app@workspace:.", "x@link:../x").
      name = header.startsWith("__metadata") || /@(?:workspace|link|portal|file):/.test(header) ? null : yarnName(header.split(/,\s*/)[0]);
      seenHeader = true;
      continue;
    }
    const v = /^ {2}version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (v && name) {
      out.push({ name, version: v[1], dev: false });
      name = null;
    }
  }
  return seenHeader ? collect(out) : null;
}

// bun.lock is JSON with trailing commas.
export function parseBunLock(text: string): Dep[] | null {
  const j = parseJson(text.replace(/,(\s*[}\]])/g, "$1"));
  if (!isObj(j) || !isObj(j.packages)) return null;
  const out: Dep[] = [];
  for (const v of Object.values(j.packages)) {
    if (!Array.isArray(v) || typeof v[0] !== "string") continue;
    const id = v[0];
    const at = id.lastIndexOf("@");
    if (at <= 0) continue;
    out.push({ name: id.slice(0, at), version: id.slice(at + 1), dev: false });
  }
  return collect(out);
}

export type Manifest = {
  dependencies: Record<string, string>; devDependencies: Record<string, string>; optionalDependencies: Record<string, string>;
};

const strMap = (v: unknown): Record<string, string> =>
  isObj(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string")) : {};

export function parseManifest(text: string): Manifest | null {
  const j = parseJson(text);
  if (!isObj(j)) return null;
  return { dependencies: strMap(j.dependencies), devDependencies: strMap(j.devDependencies), optionalDependencies: strMap(j.optionalDependencies) };
}

// The lowest version a simple range allows: "^1.2.3", "~1.2", ">=1.2.3", "1.2.3", "v1.2.3". Anything else (tags, URLs,
// workspace:, unions, hyphen ranges) → null.
export function minVersion(range: string): string | null {
  const m = /^\s*(?:\^|~|>=|=|v)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(-[0-9A-Za-z.-]+)?\s*$/.exec(range);
  if (!m) return null;
  const n = (s: string | undefined) => (s && /^\d+$/.test(s) ? s : "0");
  return `${m[1]}.${n(m[2])}.${n(m[3])}${m[4] ?? ""}`;
}

// No lockfile: the manifest's direct dependencies at the lowest version their range allows (approximate).
export function depsFromManifest(m: Manifest): Dep[] {
  const out: Dep[] = [];
  const add = (map: Record<string, string>, dev: boolean) => {
    for (const [name, range] of Object.entries(map)) {
      const v = minVersion(range);
      if (v) out.push({ name, version: v, dev });
    }
  };
  add(m.dependencies, false);
  add(m.optionalDependencies, false);
  add(m.devDependencies, true);
  return collect(out);
}

export function parseLockfile(kind: Exclude<LockKind, "package-json">, text: string): Dep[] | null {
  switch (kind) {
    case "npm": return parsePackageLock(text);
    case "pnpm": return parsePnpmLock(text);
    case "yarn": return parseYarnLock(text);
    case "bun": return parseBunLock(text);
  }
}

// The manifest's direct dependency names (any group).
export function directNames(m: Manifest | null): Set<string> {
  if (!m) return new Set();
  return new Set([...Object.keys(m.dependencies), ...Object.keys(m.devDependencies), ...Object.keys(m.optionalDependencies)]);
}
