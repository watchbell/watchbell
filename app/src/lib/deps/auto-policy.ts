import type { DepSeverity } from "@/db/schema";
import { compareVersions } from "@/lib/security/semver";
import { type Dep, isVersion, type Manifest, minVersion } from "./lockfile";
import type { OpenVuln, Upgrade } from "./plan";

// Automatic security fixes (owner 16 Oct: "Just automate it, it's about dependency security"). Pure. Which update PR may
// open without asking, which open Watchbell PRs it must not duplicate, and the stale-lockfile view of a scan.

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// Same major (for 0.x also the same minor: npm treats 0.y as breaking), and not a downgrade. Pre-releases count by their
// numbers (1.2.3-beta → 1). Anything unreadable → false.
export function sameMajor(from: string, to: string): boolean {
  const a = SEMVER.exec(from.trim());
  const b = SEMVER.exec(to.trim());
  if (!a || !b) return false;
  if (a[1] !== b[1]) return false;
  if (a[1] === "0" && a[2] !== b[2]) return false;
  return compareVersions(to, from) >= 0;
}

export type AutoPick = { ok: true; upgrades: Upgrade[] } | { ok: false; why: "severity" | "major" | "nothing" };

// The upgrades an automatic PR may carry: those whose advisories' worst severity is one the owner chose; every one of
// them must stay in its major (from the installed version). Any that doesn't → the whole proposal waits for the owner.
// Upgrades are direct packages only (upgradesFor leaves transitive ones out). A moderate one counts only for a production
// dependency (Watchbell 1.2.1, like the VulnerableDependency alert): a devDependency-only moderate fix waits for the owner.
export function autoPick(upgrades: Upgrade[], installed: ReadonlyMap<string, string>, severities: readonly DepSeverity[]): AutoPick {
  if (!upgrades.length) return { ok: false, why: "nothing" };
  const picked = upgrades.filter((u) => severities.includes(u.severity) && !(u.severity === "moderate" && u.dev));
  if (!picked.length) return { ok: false, why: "severity" };
  for (const u of picked) {
    const from = installed.get(u.package);
    if (!from || !sameMajor(from, u.to)) return { ok: false, why: "major" };
  }
  return { ok: true, upgrades: picked };
}

// The lowest installed version of each direct package with an open advisory (what the PR moves away from).
export function installedOf(vulns: Pick<OpenVuln, "package" | "installedVersion" | "direct">[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of vulns) {
    if (!v.direct) continue;
    const had = out.get(v.package);
    if (!had || compareVersions(v.installedVersion, had) < 0) out.set(v.package, v.installedVersion);
  }
  return out;
}

// ---- never two open Watchbell PRs for the same repository and package ----
export type OpenWatchpostPr = { number: number; branch: string; title: string; packages: string[] | null };

// The packages of an open Watchbell PR: what we stored when we opened it, else read from its title
// ("Watchbell: update next to 15.0.5 (security fix)"; PRs opened earlier say "ke" instead of "to", and PRs opened before
// the rename start with "Watchpost:"). A multi-package title we didn't store blocks every package.
export function prPackages(pr: OpenWatchpostPr): string[] | "all" {
  if (pr.packages?.length) return pr.packages;
  const m = /^Watch(?:bell|post): update (\S+) (?:to|ke) /.exec(pr.title);
  return m ? [m[1]] : "all";
}

// The monorepo folder a Watchbell PR edits, from its title (bump.ts prTitle: "Watchbell: update next to 16.4.1 in
// apps/web (security fix)", "Watchbell: update 2 vulnerable packages in apps/web (next, vite)"). Null: the repository
// root, also for every PR opened before Watchbell 1.2.1 (their titles never name a folder).
const TITLE_DIR = /^Watch(?:bell|post): update (?:\S+ (?:to|ke) \S+|\d+ vulnerable packages) in ((?:[A-Za-z0-9._-]+\/){0,3}[A-Za-z0-9._-]+) \(/;
export const prDir = (title: string): string | null => TITLE_DIR.exec(title)?.[1] ?? null;

// The open PR that already covers one of these packages, or null. dir (Watchbell 1.2.1, review T1): only PRs of the
// same folder count, so two apps of one repository (apps/web, apps/admin) each get their own PR.
export function overlappingPr(packages: string[], open: OpenWatchpostPr[], dir: string | null = null): OpenWatchpostPr | null {
  for (const pr of open) {
    if (prDir(pr.title) !== dir) continue;
    const has = prPackages(pr);
    if (has === "all" || packages.some((p) => has.includes(p))) return pr;
  }
  return null;
}

// ---- stale lockfile ----
// Our PRs change only package.json, so after a merge the lockfile still pins the old version while Vercel's install
// takes the new one. For a DIRECT dependency whose package.json range no longer allows the lockfile's version (it asks
// for more), the effective version is the range's minimum, and the advisories are read at that version. Returns the
// effective list and the names whose lockfile is behind. Older copies of the same package pulled in by other packages
// stay as they are when the range's minimum is already in the list.
export function effectiveDeps(deps: Dep[], manifest: Manifest | null): { deps: Dep[]; stale: string[] } {
  if (!manifest) return { deps, stale: [] };
  const specs: [string, string, boolean][] = [
    ...Object.entries(manifest.dependencies).map(([n, r]) => [n, r, false] as [string, string, boolean]),
    ...Object.entries(manifest.optionalDependencies).map(([n, r]) => [n, r, false] as [string, string, boolean]),
    ...Object.entries(manifest.devDependencies).map(([n, r]) => [n, r, true] as [string, string, boolean]),
  ];
  let out = [...deps];
  const stale: string[] = [];
  for (const [name, range, dev] of specs) {
    const min = minVersion(range);
    if (!min || !isVersion(min)) continue;
    const mine = out.filter((d) => d.name === name);
    if (!mine.length || mine.some((d) => compareVersions(d.version, min) >= 0)) continue;
    // Every copy in the lockfile is below what package.json asks for: the lockfile is behind.
    out = out.filter((d) => d.name !== name);
    out.push({ name, version: min, dev: mine.every((d) => d.dev) && dev });
    stale.push(name);
  }
  return { deps: out, stale };
}

export const STALE_NOTE = (names: string[]): string =>
  `Lockfile tertinggal — jalankan npm install (${names.slice(0, 5).join(", ")}${names.length > 5 ? `, +${names.length - 5}` : ""}).`;
