import { compareVersions } from "@/lib/security/semver";
import { isPackageName, isVersion, minVersion } from "./lockfile";
import type { Upgrade } from "./plan";
import { DEPS_COPY } from "@/lib/copy/edition";

// Stage 9 slice 5: the pull request the owner approves ("Open package update PR"). Pure: which package.json ranges change,
// the edited package.json text, the branch name, and the PR's title and body (in English).
// The lockfile can't be regenerated on the server, so the PR body asks for `npm install` (or the repo's own tool) before
// merging. The branch is always a new "watchpost/deps-…" branch (the prefix predates the Watchbell rename and stays,
// so open PRs keep matching): never the default branch.

export const GROUPS = ["dependencies", "devDependencies", "optionalDependencies"] as const;
export type Group = (typeof GROUPS)[number];
// companionOf: updated only to match another bump (Upgrade.companionOf); not a vulnerable package itself.
export type Bump = { package: string; group: Group; from: string; to: string; fixed: string; vulnIds: string[]; cves: string[]; companionOf?: string };
export const BRANCH_PREFIX = "watchpost/deps-";
export const PACKAGE_JSON_MAX = 256 * 1024;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// "^1.2.3" → "^<fixed>", "~1.2.3" → "~<fixed>", "1.2.3" → "<fixed>", ">=1.2.3" → ">=<fixed>". Ranges the PR can't
// rewrite safely (tags, URLs, workspace:, unions) → null.
export function bumpRange(range: string, fixed: string): string | null {
  const m = /^\s*(\^|~|>=|=)?\s*v?\d+(?:\.(?:\d+|x|\*))?(?:\.(?:\d+|x|\*))?(?:-[0-9A-Za-z.-]+)?\s*$/.exec(range);
  if (!m || !isVersion(fixed)) return null;
  return `${m[1] ?? ""}${fixed}`;
}

// The ranges to change in this package.json: each upgrade whose package is listed directly and whose range still allows
// a version below the fix.
export function planBumps(manifestText: string, upgrades: Upgrade[]): Bump[] | null {
  let j: unknown;
  try {
    j = JSON.parse(manifestText);
  } catch {
    return null;
  }
  if (!isObj(j)) return null;
  const out: Bump[] = [];
  for (const u of upgrades) {
    if (!isPackageName(u.package) || !isVersion(u.to)) continue;
    for (const group of GROUPS) {
      const deps = j[group];
      if (!isObj(deps) || typeof deps[u.package] !== "string") continue;
      const from = deps[u.package] as string;
      const low = minVersion(from);
      const to = bumpRange(from, u.to);
      if (!low || !to || compareVersions(low, u.to) >= 0) continue;
      out.push({ package: u.package, group, from, to, fixed: u.to, vulnIds: u.vulnIds, cves: u.cves, ...(u.companionOf ? { companionOf: u.companionOf } : {}) });
    }
  }
  return out;
}

// The edited package.json: only the bumped ranges change; key order, indentation, line endings and the final newline stay.
export function applyBumps(manifestText: string, bumps: Bump[]): string | null {
  let j: unknown;
  try {
    j = JSON.parse(manifestText);
  } catch {
    return null;
  }
  if (!isObj(j)) return null;
  for (const b of bumps) {
    const deps = j[b.group];
    if (!isObj(deps) || deps[b.package] !== b.from) return null;
    deps[b.package] = b.to;
  }
  const indentMatch = /^[{[]\r?\n([ \t]+)\S/.exec(manifestText);
  const indent = indentMatch ? indentMatch[1] : "  ";
  const eol = manifestText.includes("\r\n") ? "\r\n" : "\n";
  let text = JSON.stringify(j, null, indent);
  if (eol === "\r\n") text = text.replace(/\n/g, "\r\n");
  return /\r?\n$/.test(manifestText) ? text + eol : text;
}

// FNV-1a, so the same set of bumps always names the same branch (a second approval finds the first PR).
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// dir (Watchbell 1.2.1, review T1): the monorepo folder whose package.json the PR edits is part of the key, so two apps
// of one repository (apps/web, apps/admin) with the same bumps get two branches. A root PR keeps the key it always had,
// so the dedupe still finds PRs opened before.
export function branchName(bumps: Bump[], dir: string | null = null): string {
  const key = bumps.map((b) => `${b.package}@${b.to}`).sort().join(",");
  return `${BRANCH_PREFIX}${fnv(dir ? `${dir}|${key}` : key)}`;
}

// A branch the PR flow may create and write: ours, and never the default one.
export const isOwnBranch = (branch: string, defaultBranch: string): boolean =>
  branch.startsWith(BRANCH_PREFIX) && /^watchpost\/deps-[0-9a-f]{8}$/.test(branch) && branch !== defaultBranch;

// The vulnerable bumps (a companion only follows one of them); a list of companions alone counts them all.
const vulnerable = (bumps: Bump[]): Bump[] => {
  const v = bumps.filter((b) => !b.companionOf);
  return v.length ? v : bumps;
};

export function commitMessage(bumps: Bump[]): string {
  const v = vulnerable(bumps);
  return v.length === 1 ? `chore(deps): update ${v[0].package} to ${v[0].fixed} (security fix)` : `chore(deps): update ${v.length} packages for security fixes`;
}

// "Watchbell: update next to 16.4.1 in apps/web (security fix)": the folder (when not the root) is read back by
// auto-policy.ts prDir, so the open-PR dedupe stays per folder.
export function prTitle(bumps: Bump[], dir: string | null = null): string {
  const v = vulnerable(bumps);
  const where = dir ? ` in ${dir}` : "";
  const t = v.length === 1
    ? `Watchbell: update ${v[0].package} to ${v[0].fixed}${where} (security fix)`
    : `Watchbell: update ${v.length} vulnerable packages${where} (${v.slice(0, 2).map((b) => b.package).join(", ")}${v.length > 2 ? ", …" : ""})`;
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

const LOCK_CMD: Record<string, string> = {
  npm: "npm install", pnpm: "pnpm install", yarn: "yarn install", bun: "bun install", "package-json": "npm install",
};

// `auto`: opened by "Automatic security fixes"; Watchbell merges it itself once CI, the preview and its smoke test
// pass (and auto-rollback is on), so the lockfile is updated afterwards on the main branch.
// dir: the monorepo folder whose package.json changed ("run `npm install` in `apps/web`").
export function prBody(bumps: Bump[], lockKind: string | null, auto = false, dir: string | null = null): string {
  const cmd = LOCK_CMD[lockKind ?? "npm"] ?? "npm install";
  const run = `run \`${cmd}\`${dir ? ` in \`${dir}\`` : ""}`;
  const vuln = bumps.filter((b) => !b.companionOf);
  const companions = bumps.filter((b) => b.companionOf);
  const rows = vuln.map((b) => {
    const refs = [...b.cves, ...b.vulnIds.filter((id) => !b.cves.includes(id))].slice(0, 4)
      .map((id) => `[${id}](https://osv.dev/vulnerability/${encodeURIComponent(id)})`).join(", ");
    return `| \`${b.package}\` | \`${b.from}\` | \`${b.to}\` | ${refs || "-"} |`;
  });
  return [
    auto
      ? "This PR was opened **automatically** by Watchbell (Automatic security fixes). Watchbell merges it itself when CI is green, the Vercel preview is READY and passes the smoke test, and auto-rollback is on; if anything fails, the PR stays open for you to check."
      : DEPS_COPY.prApproved,
    "",
    "These packages have known vulnerabilities (source: OSV.dev / GitHub Advisory) and a fixed version exists:",
    "",
    "| Package | Current version | New version | Advisory |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    ...companions.map((b) => `Updated to match ${b.companionOf} (no advisory of its own): \`${b.package}\` \`${b.from}\` → \`${b.to}\`.`),
    ...(companions.length ? [""] : []),
    "### Important: the lockfile is not updated",
    "",
    auto
      ? `Watchbell only changes \`package.json\`; it can't regenerate the lockfile on the server. Vercel installs the new version at build time, so production is safe after the merge. Afterwards ${run} on the main branch and commit the lockfile to bring it up to date.`
      : `Watchbell only changes \`package.json\`; it can't regenerate the lockfile on the server. Before merging, check out this branch, ${run}, then commit the changed lockfile. Then make sure the build and tests still pass.`,
    "",
    "Vulnerable packages that are only installed through other packages (transitive) are not changed here; check with `npm audit` after installing.",
    "",
    "_Nothing is pushed to the main branch: all changes are on this PR branch._",
  ].join("\n");
}
