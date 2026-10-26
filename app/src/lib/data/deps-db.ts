import "server-only";
import { effectiveDeps, STALE_NOTE } from "@/lib/deps/auto-policy";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, notInArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, appRepos, dependencyPrs, dependencyScans, dependencyVulns, type DepSeverity, githubRepos, resources, settings } from "@/db/schema";
import { openOrNull } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { isUuid } from "@/lib/ids";
import { type Dep, depsFromManifest, directNames, LOCKFILES, type LockKind, parseLockfile, parseManifest } from "@/lib/deps/lockfile";
import { findings } from "@/lib/deps/osv";
import { advisories, queryBatch } from "@/lib/deps/osv-client";
import { cleanRootDir, dirText, inDir, lockCoversDir, unusableRootDir, workspaceCovers } from "@/lib/deps/root-dir";
import { idsToRead, knownFindings, mergeDependabot, type OpenVuln, planVulns, rank, scanDue, scanOrder, upgradesFor } from "@/lib/deps/plan";
import { branchExists, dependabotAlerts, LOCKFILE_MAX_BYTES, type RootFile, repoFile, rootFiles } from "@/lib/providers/github-deps";
import { productionCandidate, scanBranchOf, scanFallbackOf } from "@/lib/deps/branch";
import { PACKAGE_MAX_BYTES } from "@/lib/providers/github";
import type { FetchOpts } from "@/lib/providers/http";

// Stage 9 slice 5 (owner 16 Oct): the dependency (CVE) scan's rows (0034 ops.dependency_scans, ops.dependency_vulns).
// Read-only everywhere else: GitHub GETs with the read-only token (the root file list, package.json, the lockfile, the
// Dependabot alerts when allowed) and OSV.dev queries. Which repositories: those linked to an app, plus every synced
// repository when ops.settings "deps.scanAll" is true. An unchanged lockfile (same blob SHA) is not downloaded or
// queried again for RESCAN_MS (plan.ts). Bounded by a deadline: the daily step continues the next day where it stopped.

export const SCAN_ALL_SETTING = "deps.scanAll";
export const DEPS_STEP_MS = 12_000; // the daily step's share
export const DEPS_HARD_STOP_MS = 40_000; // never past this into the daily run, so the steps after keep their time
export const MIN_REPO_MS = 4_000; // no repository scan starts with less left
export const SCAN_NOW_MS = 40_000; // "Scan now" on the app page (the page allows 60 s)
const KEEP_RESOLVED_MS = 90 * 86_400_000;
const MAX_REPOS = 500;
const MAX_OPEN = 2_000;

type Token = { token: string; accountId: string } | { error: string };

async function readToken(): Promise<Token> {
  const [a] = await db().select().from(accounts).where(eq(accounts.provider, "github")).orderBy(asc(accounts.createdAt)).limit(1);
  if (!a) return { error: "GitHub isn't connected." };
  const token = openOrNull({ ciphertext: a.credentialCiphertext, iv: a.credentialIv }, serverEnv().OPS_ENCRYPTION_KEY);
  return token ? { token, accountId: a.id } : { error: "Can't read the stored GitHub credential. Replace it on Connections." };
}

// rootDir (Watchbell 1.2): the folder whose package.json and lockfile are scanned (the linked app's Vercel Root
// Directory); null or absent: the repository root. rootDirUnsupported (1.2.1, review T1): a Root Directory the app has
// that couldn't be used, so the root is scanned and the Dependencies card says why. prodBranch (1.2.1, fix round 1): the
// linked app's Vercel production branch, read instead of the default branch when the repository has it.
export type ScanTarget = {
  id: string; fullName: string; defaultBranch: string | null; scannedAt: Date | null; rootDir?: string | null; rootDirUnsupported?: string | null; prodBranch?: string | null;
  // 1.2.2 (D15): the production branch, tried when prodBranch (the branch production was built from) isn't in the repository.
  prodFallback?: string | null;
};

async function scanAll(): Promise<boolean> {
  const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, SCAN_ALL_SETTING)).limit(1);
  return row?.value === true;
}

// An app's folder from its resources.meta: the usable Root Directory, or the text of one that couldn't be used; and its
// Vercel production branch (null: none, or not a plain branch name). 1.2.2 (D15): the Git branch the live production
// deployment was really built from (meta.productionSource) comes first: production can be built from another branch.
// `fallback` (only when there is one): the production branch, tried next.
export type ScanDir = { dir: string | null; unsupported: string | null; branch: string | null; fallback?: string };
const dirOf = (meta: Record<string, unknown> | null): ScanDir => {
  const fallback = scanFallbackOf(meta);
  return {
    dir: cleanRootDir((meta ?? {}).rootDirectory), unsupported: unusableRootDir((meta ?? {}).rootDirectoryUnsupported),
    branch: productionCandidate(scanBranchOf(meta), null), ...(fallback ? { fallback } : {}),
  };
};

// Watchbell 1.2: which folder of each repository is scanned: the Vercel Root Directory (resources.meta.rootDirectory,
// written by the account sync) of the app linked to it. When several live apps share a repository, a watched
// (monitored) app decides before an unwatched one, then the first by name (one scan row per repository; review T1).
// A repository no app links to is scanned at the root.
export async function scanDirs(repoIds: string[]): Promise<Map<string, ScanDir>> {
  const ids = [...new Set(repoIds.filter(isUuid))];
  const out = new Map<string, ScanDir>();
  if (!ids.length) return out;
  const rows = await db().select({ repoId: appRepos.repoId, name: resources.name, monitored: resources.monitored, meta: resources.meta }).from(appRepos)
    .innerJoin(resources, eq(resources.id, appRepos.appId)).where(and(inArray(appRepos.repoId, ids), isNull(resources.goneAt))).limit(MAX_REPOS * 2);
  rows.sort((a, b) => Number(!!b.monitored) - Number(!!a.monitored) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const r of rows) if (!out.has(r.repoId)) out.set(r.repoId, dirOf(r.meta as Record<string, unknown> | null));
  return out;
}

// Linked repositories (and every live one with "deps.scanAll"), never-scanned first, then the oldest scan.
export async function reposToScan(): Promise<ScanTarget[]> {
  const cols = { id: githubRepos.id, fullName: githubRepos.fullName, defaultBranch: githubRepos.defaultBranch, scannedAt: dependencyScans.scannedAt };
  const live = and(isNull(githubRepos.goneAt), eq(githubRepos.archived, false));
  const rows = (await scanAll())
    ? await db().select(cols).from(githubRepos).leftJoin(dependencyScans, eq(dependencyScans.repoId, githubRepos.id)).where(live).limit(MAX_REPOS)
    : await db().selectDistinct(cols).from(appRepos).innerJoin(githubRepos, eq(githubRepos.id, appRepos.repoId))
      .leftJoin(dependencyScans, eq(dependencyScans.repoId, githubRepos.id)).where(live).limit(MAX_REPOS);
  const dirs = rows.length ? await scanDirs(rows.map((r) => r.id)) : new Map<string, ScanDir>();
  return scanOrder(rows.map((r) => {
    const d = dirs.get(r.id);
    return { ...r, rootDir: d?.dir ?? null, rootDirUnsupported: d?.unsupported ?? null, prodBranch: d?.branch ?? null, ...(d?.fallback ? { prodFallback: d.fallback } : {}) };
  }));
}

export type RepoScan = { status: "scanned" | "unchanged" | "failed"; error?: string; vulns?: number; packages?: number; note?: string | null };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function saveScan(repoId: string, v: Partial<typeof dependencyScans.$inferInsert>): Promise<void> {
  const now = new Date();
  await db().insert(dependencyScans).values({ repoId, ...v, updatedAt: now })
    .onConflictDoUpdate({ target: dependencyScans.repoId, set: { ...v, updatedAt: now } });
}

async function openVulns(repoId: string): Promise<(OpenVuln & { source: "osv" | "dependabot" })[]> {
  return db().select({
    id: dependencyVulns.id, package: dependencyVulns.package, installedVersion: dependencyVulns.installedVersion, vulnId: dependencyVulns.vulnId,
    severity: dependencyVulns.severity, fixedVersion: dependencyVulns.fixedVersion, summary: dependencyVulns.summary, aliases: dependencyVulns.aliases,
    dev: dependencyVulns.dev, direct: dependencyVulns.direct, source: dependencyVulns.source,
  }).from(dependencyVulns).where(and(eq(dependencyVulns.repoId, repoId), isNull(dependencyVulns.resolvedAt))).limit(MAX_OPEN);
}

function pickLockfile(files: RootFile[], dir: string | null): { path: string; kind: Exclude<LockKind, "package-json">; sha: string } | null {
  for (const l of LOCKFILES) {
    const f = files.find((x) => x.name === l.path);
    if (f) return { path: inDir(dir, l.path), kind: l.kind, sha: f.sha };
  }
  return null;
}

// One repository: the scanned folder's file list (one GET) decides whether anything is downloaded at all. The folder is
// the root, or (Watchbell 1.2) the linked app's Vercel Root Directory; there, a package.json without a lockfile of its
// own uses the repository root's lockfile (npm, pnpm, yarn and bun workspaces keep one lockfile at the root).
// The branch (Watchbell 1.2.1): the app's Vercel production branch when the repository has it (one more GET), so the
// advisories are those of what is live; else the default branch. The scan key names a production branch, so a change of
// branch scans again; a default-branch scan keeps the key it always had.
export async function scanRepo(token: string, repo: ScanTarget, deadline: number, opts: FetchOpts & { force?: boolean } = {}): Promise<RepoScan> {
  const left = () => deadline - Date.now();
  const gh = (): FetchOpts => ({ ...opts, timeoutMs: Math.max(1000, Math.min(left(), 10_000)) });
  const fail = async (error: string): Promise<RepoScan> => {
    await saveScan(repo.id, { error: clip(error, 300), scannedAt: new Date() }).catch(() => undefined);
    return { status: "failed", error };
  };
  let ref = repo.defaultBranch ?? "HEAD";
  // 1.2.2 (D15): the branch production was built from, then the production branch (prodFallback), the first the
  // repository has, in the same order as the update PR's base (lib/deps/branch.ts baseCandidates).
  let prod: string | null = null;
  for (const b of [repo.prodBranch, repo.prodFallback]) {
    if (b && b === repo.defaultBranch) break;
    const c = productionCandidate(b, repo.defaultBranch);
    if (!c) continue;
    const has = await branchExists(token, repo.fullName, c, gh());
    if (!has.ok) return fail(has.error);
    if (has.data) {
      prod = c;
      break;
    }
  }
  const onProd = prod !== null;
  if (prod) ref = prod;
  const branchNote = onProd ? `Scanned ${prod}, the branch production is built from.` : null;
  const dir = cleanRootDir(repo.rootDir);
  // An app's Root Directory that couldn't be used: the root is scanned, and the note says so first (review T1).
  const odd = dir ? null : unusableRootDir(repo.rootDirUnsupported);
  const oddNote = odd ? `The Vercel Root Directory "${odd}" couldn't be used (Watchbell reads plain folder names, at most 4 deep); scanned the repository root.` : null;
  const files = await rootFiles(token, repo.fullName, ref, gh(), dir);
  if (!files.ok) return fail(dir && files.kind === "missing" ? `The folder ${dirText(dir)} isn't in ${repo.fullName} on ${ref}.` : files.error);
  let lock = pickLockfile(files.data, dir);
  const manifestFile = files.data.find((f) => f.name === "package.json") ?? null;
  let rootLock = false;
  let top: RootFile[] | null = null;
  if (dir && manifestFile && !lock) {
    const t = await rootFiles(token, repo.fullName, ref, gh());
    if (!t.ok) return fail(t.error);
    top = t.data;
    lock = pickLockfile(top, null);
    rootLock = lock !== null;
  }
  const blob = lock ? lock.sha : manifestFile ? `pkg:${manifestFile.sha}` : null;
  // A folder's key names the folder (a changed Root Directory scans again) and, with the root's lockfile, the folder's
  // package.json too (the workspace lockfile doesn't change when only that package.json does).
  // A root scan standing in for an unusable Root Directory has its own key too, so the card's note appears on the next run.
  const key = blob && dir ? `${dir}:${blob}${rootLock && manifestFile ? `+${manifestFile.sha}` : ""}` : blob && odd ? `odd:${blob}` : blob;
  const sha = key && onProd ? `br:${prod}:${key}` : key;
  const [row] = await db().select().from(dependencyScans).where(eq(dependencyScans.repoId, repo.id)).limit(1);
  const now = new Date();
  if (!scanDue(row ?? null, sha, now, opts.force)) return { status: "unchanged" };

  // Nothing to scan: no package.json and no lockfile in the folder.
  if (!sha) {
    const open = await openVulns(repo.id);
    if (open.length) await db().update(dependencyVulns).set({ resolvedAt: now }).where(inArray(dependencyVulns.id, open.map((o) => o.id)));
    await saveScan(repo.id, { lockfilePath: null, lockfileSha: null, packageCount: 0, scannedAt: now, queriedAt: now, error: null, note: clip([branchNote, oddNote, `No package.json or lockfile ${dir ? "in" : "at"} ${dirText(dir)}.`].filter(Boolean).join(" "), 300) });
    return { status: "scanned", vulns: 0, packages: 0, note: "no package.json" };
  }

  const manifestPath = inDir(dir, "package.json");
  const manifestText = manifestFile ? await repoFile(token, repo.fullName, manifestPath, ref, PACKAGE_MAX_BYTES, gh()) : null;
  if (manifestText && !manifestText.ok) return fail(manifestText.error);
  const manifest = manifestText?.ok && manifestText.data ? parseManifest(manifestText.data) : null;
  let deps: Dep[] | null = null;
  let kind: LockKind = "package-json";
  let note: string | null = rootLock && lock ? `Scanned ${dirText(dir)} with the repository root's ${lock.path} (workspaces).` : null;
  if (lock) {
    if (left() < 2_000) return fail("Time budget used before the lockfile was read; the next run tries again.");
    const text = await repoFile(token, repo.fullName, lock.path, ref, LOCKFILE_MAX_BYTES, { ...opts, timeoutMs: Math.max(1000, Math.min(left(), 20_000)) });
    if (!text.ok) return fail(text.error);
    // The root's lockfile describes the folder only when the root is a workspace that includes it (the lockfile lists
    // the folder, or the root package.json's workspaces match it); otherwise the folder's package.json ranges (review T1).
    let covered = true;
    if (rootLock && dir && text.data && !lockCoversDir(lock.kind, text.data, dir)) {
      const rootPkg = top?.some((f) => f.name === "package.json") ? await repoFile(token, repo.fullName, "package.json", ref, PACKAGE_MAX_BYTES, gh()) : null;
      if (rootPkg && !rootPkg.ok) return fail(rootPkg.error);
      covered = workspaceCovers(rootPkg?.data ?? null, dir);
    }
    if (!covered) {
      note = `The repository root's ${lock.path} isn't a workspace that includes ${dir}, so the versions come from ${manifestPath} ranges (approximate).`;
      lock = null;
    } else {
      deps = text.data ? parseLockfile(lock.kind, text.data) : null;
      kind = lock.kind;
      if (!deps) note = [note, `${lock.path} couldn't be read; the versions come from package.json ranges (approximate).`].filter(Boolean).join(" ");
    }
  }
  if (!deps) {
    deps = manifest ? depsFromManifest(manifest) : [];
    kind = "package-json";
    note ??= lock ? null : "No lockfile: the versions come from package.json ranges (approximate).";
  } else {
    // Automatic security fixes: our PRs change only package.json, so the lockfile can lag behind a merged update while
    // Vercel's install already uses the new version. A direct package whose range no longer allows the lockfile's
    // version is read at the range's minimum (the advisory then resolves instead of being proposed again).
    const eff = effectiveDeps(deps, manifest);
    deps = eff.deps;
    if (eff.stale.length) note = [note, STALE_NOTE(eff.stale)].filter(Boolean).join(" ");
  }

  const open = await openVulns(repo.id);
  let found: ReturnType<typeof findings> = [];
  if (deps.length) {
    const ids = await queryBatch(deps, { fetch: opts.fetch, deadline });
    if (!ids.ok) return fail(ids.error);
    // Advisories already stored for the same package version (with a fix) aren't read again.
    const known = knownFindings(open, opts.force === true);
    const adv = await advisories(idsToRead(deps, ids.ids, known), { fetch: opts.fetch, deadline });
    if (!adv.ok) return fail(adv.error);
    found = findings(deps, ids.ids, adv.map, known);
  }
  // Dependabot alerts, when the token may read them; a 403/404 is a note, not a failure.
  if (left() > 1_500) {
    const dep = await dependabotAlerts(token, repo.fullName, gh());
    if (dep.ok && "alerts" in dep.data) found = mergeDependabot(found, dep.data.alerts, deps);
    else if (dep.ok) note = [note, "Dependabot alerts aren't readable with this token (optional: Dependabot alerts: Read)."].filter(Boolean).join(" ");
  }

  const plan = planVulns(open, found, directNames(manifest));
  note = [branchNote, oddNote, note].filter(Boolean).join(" ") || null;
  const at = new Date();
  await db().transaction(async (tx) => {
    if (plan.insert.length) {
      await tx.insert(dependencyVulns).values(plan.insert.map((v) => ({
        repoId: repo.id, package: v.package, installedVersion: v.installedVersion, vulnId: v.vulnId, aliases: v.aliases, severity: v.severity,
        fixedVersion: v.fixedVersion, summary: v.summary, direct: v.direct, dev: v.dev, source: v.source, firstSeenAt: at, lastSeenAt: at,
      }))).onConflictDoNothing();
    }
    for (const u of plan.update) {
      await tx.update(dependencyVulns).set({ severity: u.severity, fixedVersion: u.fixedVersion, summary: u.summary, aliases: u.aliases, dev: u.dev, direct: u.direct, lastSeenAt: at })
        .where(eq(dependencyVulns.id, u.id));
    }
    if (plan.resolve.length) await tx.update(dependencyVulns).set({ resolvedAt: at }).where(and(inArray(dependencyVulns.id, plan.resolve), isNull(dependencyVulns.resolvedAt)));
    await tx.insert(dependencyScans).values({
      repoId: repo.id, lockfilePath: lock?.path ?? (manifestFile ? manifestPath : null), lockfileSha: sha, packageCount: deps.length, scannedAt: at, queriedAt: at,
      error: null, note: note ? clip(note, 300) : null, updatedAt: at,
    }).onConflictDoUpdate({
      target: dependencyScans.repoId,
      set: { lockfilePath: lock?.path ?? (manifestFile ? manifestPath : null), lockfileSha: sha, packageCount: deps.length, scannedAt: at, queriedAt: at, error: null, note: note ? clip(note, 300) : null, updatedAt: at },
    });
  });
  return { status: "scanned", vulns: plan.insert.length + plan.update.length, packages: deps.length, note: kind === "package-json" ? note : null };
}

// done: the repositories tried (scanned, unchanged or failed); listed: those the run would scan, in its order.
export type DepsRun = { scanned: number; unchanged: number; failed: string[]; left: number; done: string[]; listed: string[] };
// Watchbell 1.2.1: `first` (the repositories of the apps marked after a production deploy) lead the list; `only` keeps
// just those; `skip` (fix round 1: a 6-hourly slot continuing over several minute runs) leaves those out.
export type RepoPick = { first?: readonly string[]; only?: readonly string[]; skip?: readonly string[] };
export function pickRepos<R extends { id: string }>(repos: R[], pick: RepoPick): R[] {
  const only = pick.only ? new Set(pick.only) : null;
  const skip = new Set(pick.skip ?? []);
  const list = (only ? repos.filter((r) => only.has(r.id)) : repos).filter((r) => !skip.has(r.id));
  const first = new Set(pick.first ?? []);
  return [...list.filter((r) => first.has(r.id)), ...list.filter((r) => !first.has(r.id))];
}

// The daily step, the collector's `security` task (and their tests): repositories in order until the deadline; none
// starts with < MIN_REPO_MS left.
export async function runDepsScan(deadline: number, opts: FetchOpts & RepoPick = {}): Promise<DepsRun | { error: string }> {
  const t = await readToken();
  if ("error" in t) return { error: t.error };
  const { first, only, skip, ...fetchOpts } = opts;
  const repos = pickRepos(await reposToScan(), { first, only, skip });
  const out: DepsRun = { scanned: 0, unchanged: 0, failed: [], left: 0, done: [], listed: repos.map((r) => r.id) };
  for (const [i, r] of repos.entries()) {
    if (deadline - Date.now() < MIN_REPO_MS) {
      out.left = repos.length - i;
      break;
    }
    out.done.push(r.id);
    try {
      const s = await scanRepo(t.token, r, deadline, fetchOpts);
      if (s.status === "scanned") out.scanned++;
      else if (s.status === "unchanged") out.unchanged++;
      else out.failed.push(`${r.fullName}: ${s.error}`);
    } catch (e) {
      out.failed.push(`${r.fullName}: ${e instanceof Error ? e.name : "error"}`);
    }
  }
  // Retention: resolved rows older than 90 days.
  await db().delete(dependencyVulns).where(and(isNotNull(dependencyVulns.resolvedAt), lt(dependencyVulns.resolvedAt, new Date(Date.now() - KEEP_RESOLVED_MS)))).catch(() => undefined);
  return out;
}

// A repository OSV.dev or GitHub was too slow (or rate-limited) for today: it is scanned again on the next run, like the
// ones left over when the time budget ends. Neither is a failure of the daily job (owner 17 Oct: the daily heartbeat
// went Down because one slow OSV answer made the whole run "finished with problems").
export const isDeferral = (failure: string): boolean => /didn't answer in time|no time left|time budget|rate limit/i.test(failure);

const hasGithub = async (): Promise<boolean> => (await db().select({ id: accounts.id }).from(accounts).where(eq(accounts.provider, "github")).limit(1)).length > 0;

// A run's real failures (at most 3 named), or null; repositories that wait for the next run are logged, not reported.
function problemOf(r: DepsRun): string | null {
  const hard = r.failed.filter((f) => !isDeferral(f));
  const deferred = r.failed.length - hard.length + (r.left ?? 0);
  if (deferred) console.info(`deps: ${deferred} repositor${deferred === 1 ? "y" : "ies"} wait for the next run`);
  const problems = hard.slice(0, 3);
  if (hard.length > 3) problems.push(`+${hard.length - 3} more`);
  return problems.length ? problems.join("; ") : null;
}

// daily.ts: nothing without a GitHub connection. The problem to report (a real failure), or null.
export async function depsDailyStep(deadline: number): Promise<string | null> {
  if (!(await hasGithub())) return null;
  if (deadline - Date.now() < MIN_REPO_MS) { console.info("deps: no time left today; the scan resumes tomorrow"); return null; }
  const r = await runDepsScan(deadline);
  if ("error" in r) return isDeferral(r.error) ? null : r.error;
  return problemOf(r);
}

// Watchbell 1.2.1: the collector's `security` task (every 6 hours, and early after a production deploy). The repositories
// of the `marked` apps go first (`onlyMarked`, an early run: only them); an unchanged lockfile still costs one GitHub GET
// and no OSV query (scanDue). `skip`: the repositories this 6-hourly slot already tried (a marked app's is never
// skipped). settled: the marked apps whose repository was tried, or that have nothing to scan (no GitHub connection, no
// linked or scannable repository, a credential that can't be read: reported once, not every minute); the others wait for
// the next run. done: the repositories tried; complete: nothing is left of this run's list.
export type DepsSecurityRun = { problem: string | null; settled: string[]; done: string[]; complete: boolean };
export async function depsSecurityStep(
  deadline: number, pick: { marked: readonly string[]; onlyMarked: boolean; skip?: readonly string[] }, opts: FetchOpts = {},
): Promise<DepsSecurityRun> {
  const { marked, onlyMarked } = pick;
  if (!(await hasGithub())) return { problem: null, settled: [...marked], done: [], complete: true };
  const ids = marked.filter(isUuid);
  const links = ids.length ? await db().select({ appId: appRepos.appId, repoId: appRepos.repoId }).from(appRepos).where(inArray(appRepos.appId, ids)).limit(ids.length * 5) : [];
  const repoIds = [...new Set(links.map((l) => l.repoId))];
  const linked = (app: string) => links.filter((l) => l.appId === app).map((l) => l.repoId);
  const unlinked = marked.filter((m) => !linked(m).length);
  if (onlyMarked && !repoIds.length) return { problem: null, settled: [...marked], done: [], complete: true };
  if (deadline - Date.now() < MIN_REPO_MS) return { problem: null, settled: unlinked, done: [], complete: false };
  const skip = (pick.skip ?? []).filter((id) => !repoIds.includes(id));
  const r = await runDepsScan(deadline, { ...opts, first: repoIds, ...(onlyMarked ? { only: repoIds } : { skip }) });
  if ("error" in r) return { problem: isDeferral(r.error) ? null : r.error, settled: [...marked], done: [], complete: true };
  const covered = new Set([...r.done, ...repoIds.filter((id) => !r.listed.includes(id))]);
  return { problem: problemOf(r), settled: marked.filter((m) => linked(m).every((id) => covered.has(id))), done: r.done, complete: r.left === 0 };
}

// ---- the app page ----
export type DepVulnView = Pick<OpenVuln, "package" | "installedVersion" | "vulnId" | "severity" | "fixedVersion" | "summary" | "aliases" | "dev" | "direct"> & { firstSeenAt: Date };
export type AppDepsView = {
  repo: { id: string; fullName: string } | null;
  scan: { scannedAt: Date | null; lockfilePath: string | null; packageCount: number; error: string | null; note: string | null } | null;
  vulns: DepVulnView[];
  writeConnected: boolean;
  // Automatic security fixes: Watchbell's update PRs of the last 14 days and their watcher stage, newest first.
  prs?: { number: number; stage: string; stageText: string | null; fullName: string; openedAt: Date }[];
};

export async function appDepsView(appId: string): Promise<AppDepsView> {
  const empty: AppDepsView = { repo: null, scan: null, vulns: [], writeConnected: false };
  if (!isUuid(appId)) return empty;
  const [link] = await db().select({ id: githubRepos.id, fullName: githubRepos.fullName }).from(appRepos).innerJoin(githubRepos, eq(githubRepos.id, appRepos.repoId))
    .where(eq(appRepos.appId, appId)).limit(1);
  if (!link) return empty;
  const [[scan], vulns, [w]] = await Promise.all([
    db().select({ scannedAt: dependencyScans.scannedAt, lockfilePath: dependencyScans.lockfilePath, packageCount: dependencyScans.packageCount, error: dependencyScans.error, note: dependencyScans.note })
      .from(dependencyScans).where(eq(dependencyScans.repoId, link.id)).limit(1),
    db().select({
      package: dependencyVulns.package, installedVersion: dependencyVulns.installedVersion, vulnId: dependencyVulns.vulnId, severity: dependencyVulns.severity,
      fixedVersion: dependencyVulns.fixedVersion, summary: dependencyVulns.summary, aliases: dependencyVulns.aliases, dev: dependencyVulns.dev, direct: dependencyVulns.direct,
      firstSeenAt: dependencyVulns.firstSeenAt,
    }).from(dependencyVulns).where(and(eq(dependencyVulns.repoId, link.id), isNull(dependencyVulns.resolvedAt))).limit(MAX_OPEN),
    db().select({ id: accounts.id }).from(accounts).where(eq(accounts.provider, "github_write")).limit(1),
  ]);
  vulns.sort((a, b) => rank(a.severity) - rank(b.severity) || (a.package < b.package ? -1 : a.package > b.package ? 1 : 0) || (a.vulnId < b.vulnId ? -1 : 1));
  const prs = await db().select({ number: dependencyPrs.number, stage: dependencyPrs.stage, stageText: dependencyPrs.stageText, openedAt: dependencyPrs.openedAt })
    .from(dependencyPrs).where(and(eq(dependencyPrs.repoId, link.id), gte(dependencyPrs.openedAt, new Date(Date.now() - 14 * 86_400_000))))
    .orderBy(desc(dependencyPrs.openedAt)).limit(5).catch(() => []);
  return { repo: link, scan: scan ?? null, vulns, writeConnected: !!w, prs: (prs ?? []).map((p) => ({ ...p, fullName: link.fullName })) };
}

// App page → Dependencies → Scan now: the linked repository, now (forced: the cache is skipped).
export async function scanAppNow(appId: string, opts: FetchOpts = {}): Promise<{ ok: true; message: string; app: string; repo: string; vulns: number } | { ok: false; error: string }> {
  if (!isUuid(appId)) return { ok: false, error: "That app no longer exists." };
  const [row] = await db().select({ app: resources.name, id: githubRepos.id, fullName: githubRepos.fullName, defaultBranch: githubRepos.defaultBranch, goneAt: githubRepos.goneAt, meta: resources.meta })
    .from(appRepos).innerJoin(githubRepos, eq(githubRepos.id, appRepos.repoId)).innerJoin(resources, eq(resources.id, appRepos.appId))
    .where(eq(appRepos.appId, appId)).limit(1);
  if (!row) return { ok: false, error: "Link a repository first." };
  if (row.goneAt) return { ok: false, error: "That repository is no longer shared with the GitHub token." };
  const t = await readToken();
  if ("error" in t) return { ok: false, error: t.error };
  // The clicked app's own folder (review T1), even when another app of the same repository decides the daily scan's.
  const d = dirOf(row.meta as Record<string, unknown> | null);
  const s = await scanRepo(t.token, { id: row.id, fullName: row.fullName, defaultBranch: row.defaultBranch, scannedAt: null, rootDir: d.dir, rootDirUnsupported: d.unsupported, prodBranch: d.branch, prodFallback: d.fallback ?? null }, Date.now() + SCAN_NOW_MS, { ...opts, force: true });
  if (s.status === "failed") return { ok: false, error: `The scan failed: ${s.error}` };
  const [c] = await db().select({ n: sql<number>`count(*)::int` }).from(dependencyVulns).where(and(eq(dependencyVulns.repoId, row.id), isNull(dependencyVulns.resolvedAt)));
  const n = c?.n ?? 0;
  return {
    ok: true, app: row.app, repo: row.fullName, vulns: n,
    message: n ? `${n} known vulnerabilit${n === 1 ? "y" : "ies"} in ${s.packages ?? 0} packages.` : `No known vulnerabilities in ${s.packages ?? 0} packages.`,
  };
}

// ---- alerts and proposals ----
export type DepFactVuln = { package: string; installedVersion: string; fixedVersion: string | null; severity: DepSeverity; summary: string; dev: boolean; direct: boolean };
export type AppDeps = { appId: string; repoId: string; error: string | null; vulns: DepFactVuln[] };

// The scanned apps among these (their linked repository has a scan row) and their open vulnerabilities. One read of the
// links and scans, one of the open rows.
export async function loadAppDeps(appIds: string[]): Promise<AppDeps[]> {
  const ids = appIds.filter(isUuid);
  if (!ids.length) return [];
  const scanned = await db().select({ appId: appRepos.appId, repoId: appRepos.repoId, error: dependencyScans.error })
    .from(appRepos).innerJoin(dependencyScans, eq(dependencyScans.repoId, appRepos.repoId))
    .where(and(inArray(appRepos.appId, ids), isNotNull(dependencyScans.scannedAt)));
  if (!scanned.length) return [];
  const rows = await db().select({
    repoId: dependencyVulns.repoId, package: dependencyVulns.package, installedVersion: dependencyVulns.installedVersion, fixedVersion: dependencyVulns.fixedVersion,
    severity: dependencyVulns.severity, summary: dependencyVulns.summary, dev: dependencyVulns.dev, direct: dependencyVulns.direct,
  }).from(dependencyVulns).where(and(inArray(dependencyVulns.repoId, [...new Set(scanned.map((s) => s.repoId))]), isNull(dependencyVulns.resolvedAt))).limit(MAX_OPEN * 5);
  return scanned.map((s) => ({ appId: s.appId, repoId: s.repoId, error: s.error, vulns: rows.filter((r) => r.repoId === s.repoId).map((r) => ({ package: r.package, installedVersion: r.installedVersion, fixedVersion: r.fixedVersion, severity: r.severity, summary: r.summary, dev: r.dev, direct: r.direct })) }));
}

// For the office's proposal rule: the apps whose open advisories have an upgrade the PR can make (a direct package with a
// known fixed version) → their linked repository id.
// Review T1 minor 1: `next` doesn't count for an app whose Next.js fix was already asked for (frameworkAsked: a pending or
// done FrameworkVulnerable update-PR proposal, read by the office) or whose open Watchbell PR (the last 14 days, not
// merged or closed) already updates next, so the owner isn't asked twice for the same package.
const PR_OPEN_WINDOW_MS = 14 * 86_400_000;
export async function fixableApps(appIds: string[], frameworkAsked: ReadonlySet<string> = new Set()): Promise<Map<string, string>> {
  const ids = appIds.filter(isUuid);
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const links = await db().select({ appId: appRepos.appId, repoId: appRepos.repoId }).from(appRepos).where(inArray(appRepos.appId, ids));
  if (!links.length) return out;
  const rows = await db().select({
    repoId: dependencyVulns.repoId, package: dependencyVulns.package, installedVersion: dependencyVulns.installedVersion, fixedVersion: dependencyVulns.fixedVersion,
    vulnId: dependencyVulns.vulnId, aliases: dependencyVulns.aliases, severity: dependencyVulns.severity, direct: dependencyVulns.direct,
  }).from(dependencyVulns).where(and(inArray(dependencyVulns.repoId, [...new Set(links.map((l) => l.repoId))]), isNull(dependencyVulns.resolvedAt), eq(dependencyVulns.direct, true), isNotNull(dependencyVulns.fixedVersion)))
    .limit(MAX_OPEN);
  const nextPr = rows.some((r) => r.package === "next")
    ? new Set((await db().selectDistinct({ appId: dependencyPrs.appId }).from(dependencyPrs).where(and(
      inArray(dependencyPrs.appId, ids), notInArray(dependencyPrs.stage, ["merged", "closed"]), gte(dependencyPrs.openedAt, new Date(Date.now() - PR_OPEN_WINDOW_MS)),
      sql`${dependencyPrs.packages} @> '["next"]'::jsonb`,
    )).limit(ids.length)).map((r) => r.appId))
    : new Set<string | null>();
  for (const l of links) {
    const skipNext = frameworkAsked.has(l.appId) || nextPr.has(l.appId);
    if (upgradesFor(rows.filter((r) => r.repoId === l.repoId && !(skipNext && r.package === "next"))).length) out.set(l.appId, l.repoId);
  }
  return out;
}
