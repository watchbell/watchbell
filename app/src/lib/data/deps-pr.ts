import "server-only";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, appRepos, appSecurity, dependencyPrs, dependencyScans, dependencyVulns, type DepSeverity, githubRepos, resources } from "@/db/schema";
import type { ActionResult } from "@/lib/action";
import { openOrNull } from "@/lib/crypto";
import { autoPick, installedOf, overlappingPr, sameMajor } from "@/lib/deps/auto-policy";
import { applyBumps, branchName, commitMessage, isOwnBranch, planBumps, prBody, prTitle } from "@/lib/deps/bump";
import { type FrameworkPlan, frameworkPlan, withCompanions } from "@/lib/deps/framework";
import { cleanRootDir, inDir, unusableRootDir } from "@/lib/deps/root-dir";
import { LOCKFILES, minVersion } from "@/lib/deps/lockfile";
import { stageLine } from "@/lib/deps/pr-watch";
import { type Upgrade, upgradesFor } from "@/lib/deps/plan";
import { serverEnv } from "@/lib/env";
import { isUuid } from "@/lib/ids";
import { baseCandidates, expectedBase, productionMismatch, scannedBranch } from "@/lib/deps/branch";
import { branchHead, createBranch, createPull, manifestAt, openPull, openWatchpostPulls, putManifest, repoInfo } from "@/lib/providers/github-write";
import type { Failure, FetchOpts } from "@/lib/providers/http";
import { type ActionOutcome, STALE } from "@/lib/provider-actions";
import { type Actor, finish, type Finisher, targetQuota } from "./provider-action-db";
import { dispatchLockfileUpdate } from "./actions-lockfile-db";

// Stage 9 slice 5: "Open package update PR", run only from an approved office proposal (risky: the owner always decides).
// With the separate GitHub PR-write credential (provider github_write): a new watchpost/deps-… branch from the base
// branch's head (the app's Vercel production branch when the repository has it, else the default branch: prBase),
// package.json with the vulnerable direct packages raised to their fixed versions, and a pull request in English text
// that asks for `npm install` before merging. Writes only ever go to that watchpost/deps-… branch (github-write.ts
// refuses any other), never to the base or default branch.
// Without the credential it fails with a clear sentence; nothing is written anywhere.

export const NEED_WRITE_TOKEN =
  "A GitHub PR-write token is needed: connect \"GitHub (PR write)\" on Connections (fine-grained, this repository only, Contents and Pull requests: Read and write; Commit statuses: Read for automatic merges), then ask again.";

const refuse = (message: string): ActionOutcome => ({ done: false, message });

type WriteAccount = { id: string; token: string } | null;
export async function writeAccount(): Promise<WriteAccount | "unreadable"> {
  const [a] = await db().select().from(accounts).where(eq(accounts.provider, "github_write")).orderBy(asc(accounts.createdAt)).limit(1);
  if (!a) return null;
  const token = openOrNull({ ciphertext: a.credentialCiphertext, iv: a.credentialIv }, serverEnv().OPS_ENCRYPTION_KEY);
  return token ? { id: a.id, token } : "unreadable";
}

// Automatic security fixes (owner 16 Oct): `auto` (the office auto-run) carries only the upgrades at the owner's chosen
// severities, each within its major; otherwise it refuses and nothing is written. Every run (auto or not) refuses a PR
// for a package an open Watchbell PR of this repository already updates, and records the PR it opens (ops.dependency_prs)
// for the merge watcher.
// `framework` (Watchbell 1.2): the proposal came from FrameworkVulnerable, so the PR updates `next` (and
// `eslint-config-next` when package.json lists it) to the version that clears the app's Next.js advisories
// (ops.app_security, lib/deps/framework.ts) instead of the scan's dependency advisories.
export type BumpOpts = FetchOpts & { auto?: { severities: DepSeverity[] }; proposalId?: string | null; framework?: boolean };
const MAJOR_WHY = { severity: "no package at the selected severity", major: "an update jumps a major version", nothing: "nothing can be updated" } as const;

// The app's stored Next.js check → the framework PR's plan (null: not vulnerable, or no fixed version).
async function frameworkPlanOf(appId: string): Promise<FrameworkPlan | null> {
  const [s] = await db().select({ version: appSecurity.version, status: appSecurity.status, findings: appSecurity.findings }).from(appSecurity)
    .where(eq(appSecurity.resourceId, appId)).limit(1);
  return s ? frameworkPlan({ version: s.version, status: s.status, findings: Array.isArray(s.findings) ? s.findings : [] }) : null;
}

// The scan's open advisories of a repository, as the PR's upgrades and the installed versions they move away from.
async function dependencyPlanOf(repoId: string): Promise<{ upgrades: Upgrade[]; installed: Map<string, string> }> {
  const open = await db().select({
    package: dependencyVulns.package, installedVersion: dependencyVulns.installedVersion, fixedVersion: dependencyVulns.fixedVersion, vulnId: dependencyVulns.vulnId,
    aliases: dependencyVulns.aliases, severity: dependencyVulns.severity, direct: dependencyVulns.direct, dev: dependencyVulns.dev,
  }).from(dependencyVulns).where(and(eq(dependencyVulns.repoId, repoId), isNull(dependencyVulns.resolvedAt))).limit(2_000);
  return { upgrades: upgradesFor(open), installed: installedOf(open) };
}

// The update PR's base: the first of baseCandidates (lib/deps/branch.ts) the repository has: the Git branch the live
// production deployment was built from (1.2.2, D15: resources.meta.productionSource), the app's Vercel production branch
// (resources.meta.productionBranch, 1.2.1), else the repository's default branch. head: that branch's head commit (the
// default branch's read is returned as is, so the caller reports it like before). A failed read of a candidate fails
// the run: guessing could open the PR against a branch that never deploys.
export async function prBase(
  token: string, fullName: string, defaultBranch: string, meta: Record<string, unknown> | null, o: FetchOpts,
): Promise<{ ok: true; data: { base: string; head: Awaited<ReturnType<typeof branchHead>> } } | Failure> {
  for (const b of baseCandidates(meta, defaultBranch)) {
    if (b === defaultBranch) break;
    const head = await branchHead(token, fullName, b, o);
    if (!head.ok) return head;
    if (head.data) return { ok: true, data: { base: b, head } };
  }
  return { ok: true, data: { base: defaultBranch, head: await branchHead(token, fullName, defaultBranch, o) } };
}

// The warning on top of an update PR whose base isn't what production was built from (opened as a draft).
export const prWarning = (why: string): string =>
  `> [!WARNING]\n> ${why} Check where production is built from before you merge; Watchbell won't merge this pull request itself.\n\n`;

export async function bumpPrAs(actor: Actor, appId: string, repoId: string, fin: Finisher = finish, opts: BumpOpts = {}): Promise<ActionResult> {
  if (!isUuid(appId) || !isUuid(repoId)) return fin(refuse("Something in that request wasn't valid."), actor, "");
  const quota = await targetQuota(actor.id, "github_bump_pr", appId);
  if (quota) return fin(refuse(quota), actor, "");
  const acc = await writeAccount();
  if (acc === null) return fin(refuse(NEED_WRITE_TOKEN), actor, "");
  if (acc === "unreadable") return fin(refuse("Can't read the stored GitHub PR-write credential. Replace it on Connections."), actor, "");

  // The app must still be linked to that repository (the proposal's target), and the repository still shared.
  const [row] = await db().select({
    app: resources.name, meta: resources.meta, fullName: githubRepos.fullName, owner: githubRepos.owner, goneAt: githubRepos.goneAt, lockfilePath: dependencyScans.lockfilePath,
    lockfileSha: dependencyScans.lockfileSha,
  })
    .from(appRepos).innerJoin(githubRepos, eq(githubRepos.id, appRepos.repoId)).innerJoin(resources, eq(resources.id, appRepos.appId))
    .leftJoin(dependencyScans, eq(dependencyScans.repoId, appRepos.repoId))
    .where(and(eq(appRepos.appId, appId), eq(appRepos.repoId, repoId))).limit(1);
  if (!row || row.goneAt) return fin(refuse(STALE), actor, acc.id);
  // Watchbell 1.2: the package.json in the app's Vercel Root Directory (a monorepo's "apps/web"), else the root's. A Root
  // Directory the sync couldn't use (vercel.ts rootDirectoryUnsupported) is refused rather than taken as the root (review T1).
  const meta = (row.meta ?? {}) as Record<string, unknown>;
  const odd = unusableRootDir(meta.rootDirectoryUnsupported);
  if (odd) return fin(refuse(`The Vercel Root Directory "${odd}" of ${row.app} couldn't be used (Watchbell reads plain folder names, at most 4 deep). Update its package.json yourself.`), actor, acc.id);
  const dir = cleanRootDir(meta.rootDirectory);
  const manifestPath = inDir(dir, "package.json");
  const where = dir ? `in ${dir}` : "at the repository root";
  let plan: { upgrades: Upgrade[]; installed: Map<string, string> };
  if (opts.framework) {
    const fw = await frameworkPlanOf(appId);
    if (!fw) return fin(refuse(`Nothing to update in ${row.app}: its Next.js check shows no advisory with a fixed version.`), actor, acc.id);
    plan = fw;
  } else {
    plan = await dependencyPlanOf(repoId);
    if (!plan.upgrades.length) return fin(refuse(`Nothing to update in ${row.app}: no direct package has a fixed version for its open advisories.`), actor, acc.id);
  }
  let upgrades = plan.upgrades;
  if (opts.auto) {
    const pick = autoPick(upgrades, plan.installed, opts.auto.severities);
    if (!pick.ok) return fin(refuse(`Automatic PR not opened: ${MAJOR_WHY[pick.why]}. The proposal waits for your approval.`), actor, acc.id);
    upgrades = pick.upgrades;
  }
  // eslint-config-next moves with next (review T1 minor 8); only changed when package.json lists it.
  upgrades = withCompanions(upgrades);

  const { auto, proposalId, framework, ...fetchOpts } = opts;
  const o: FetchOpts = { timeoutMs: 8_000, ...fetchOpts };
  const info = await repoInfo(acc.token, row.fullName, o);
  if (!info.ok) return fin({ done: false, failed: info, audit: { message: `Package update PR failed · ${row.app}`, resourceId: appId } }, actor, acc.id);
  // Watchbell 1.2.1 (owner 24 Oct) and 1.2.2 (D15): the branch production was really built from, else the branch Vercel
  // deploys to production, when the repository has it, else the default branch (prBase). The scan read the same branch.
  // The PR record keeps the base, so the merge watcher merges into the same branch.
  const pb = await prBase(acc.token, row.fullName, info.data.defaultBranch, meta, o);
  if (!pb.ok) return fin({ done: false, failed: pb, audit: { message: `Package update PR failed · ${row.app}`, resourceId: appId } }, actor, acc.id);
  const base = pb.data.base;
  // Watchbell 1.2.2 (D15): production wasn't built from that base (a CLI deploy, a branch the repository doesn't have), or
  // that can't be confirmed lately: merging would deploy the base to production and replace what is live. Never
  // automatically; an approved PR opens as a draft with the warning on top.
  const mismatch = productionMismatch(meta.productionSource, base, new Date());
  if (mismatch && auto) return fin(refuse(`Automatic PR not opened: ${mismatch} The proposal waits for your approval.`), actor, acc.id);
  // D15 fix round 2: the scan's advisories (the plan) must come from the branch the PR edits. After a change of source,
  // until the next scan, they may not: another branch's plan on this package.json could jump a major. Scan again first.
  // (A framework PR's plan is the app's Next.js check, not the scan.)
  const scanned = framework ? null : scannedBranch(row.lockfileSha, info.data.defaultBranch, dir);
  if (scanned && scanned !== base) {
    return fin(refuse(`The dependency scan of ${row.app} read ${scanned}, but this pull request would go to ${base}. Scan again (Dependencies › Scan now on the app page), then ask again.`), actor, acc.id);
  }
  const head = pb.data.head;
  if (!head.ok) return fin({ done: false, failed: head, audit: { message: `Package update PR failed · ${row.app}`, resourceId: appId } }, actor, acc.id);
  if (!head.data) return fin(refuse(`The default branch ${base} wasn't found.`), actor, acc.id);
  const manifest = await manifestAt(acc.token, row.fullName, head.data, o, manifestPath);
  if (!manifest.ok) return fin({ done: false, failed: manifest, audit: { message: `Package update PR failed · ${row.app}`, resourceId: appId } }, actor, acc.id);
  if (!manifest.data) return fin(refuse(`There is no package.json ${where}.`), actor, acc.id);
  const bumps = planBumps(manifest.data.text, upgrades);
  // A framework PR always updates next itself (eslint-config-next alone isn't a security fix).
  if (!bumps?.length || (framework && !bumps.some((b) => b.package === "next"))) {
    return fin(refuse(`${manifestPath} in ${row.app} already allows the fixed versions (or its ranges can't be rewritten). Run npm install there.`), actor, acc.id);
  }
  if (auto) {
    // The real ranges in package.json: each bump must still stay within its major.
    const jump = bumps.find((b) => { const from = minVersion(b.from); return !from || !sameMajor(from, b.fixed); });
    if (jump) return fin(refuse(`Automatic PR not opened: ${jump.package} ${jump.from} → ${jump.to} jumps a major version. The proposal waits for your approval.`), actor, acc.id);
  }
  const text = applyBumps(manifest.data.text, bumps);
  if (!text) return fin(refuse("package.json couldn't be edited safely."), actor, acc.id);
  // The folder is part of the PR's identity (review T1 I1): apps/web and apps/admin of one repository get their own branch.
  const branch = branchName(bumps, dir);
  if (!isOwnBranch(branch, base)) return fin(refuse("Refused: the PR branch would be the default branch."), actor, acc.id);

  // The same bumps in the same folder were proposed before (the branch names both): the open PR is the answer.
  const existing = await openPull(acc.token, row.fullName, row.owner, branch, base, o);
  if (existing.ok && existing.data) return { ok: true, message: `Pull request #${existing.data.number} for these updates is already open.` };
  // Never two open Watchbell PRs for one repository, folder and package (the packages of our own PRs are stored; others are
  // read from their title, which also names the folder: auto-policy.ts prDir).
  const openPrs = await openWatchpostPulls(acc.token, row.fullName, o);
  if (!openPrs.ok) return fin({ done: false, failed: openPrs, audit: { message: `Package update PR failed · ${row.app}`, resourceId: appId } }, actor, acc.id);
  if (openPrs.data.length) {
    const ours = await db().select({ number: dependencyPrs.number, packages: dependencyPrs.packages }).from(dependencyPrs)
      .where(and(eq(dependencyPrs.repoId, repoId), inArray(dependencyPrs.number, openPrs.data.map((p) => p.number))));
    const known = new Map(ours.map((r) => [r.number, r.packages]));
    const clash = overlappingPr(bumps.map((b) => b.package), openPrs.data.map((p) => ({ number: p.number, branch: p.branch, title: p.title, packages: known.get(p.number) ?? null })), dir);
    if (clash) return fin(refuse(`Pull request #${clash.number} for the same package is already open in ${row.app}. Merge or close it first.`), actor, acc.id);
  }
  const had = await branchHead(acc.token, row.fullName, branch, o);
  if (had.ok && had.data) return fin(refuse(`Branch ${branch} already exists without an open pull request. Delete it on GitHub, then ask again.`), actor, acc.id);

  // The scan's lockfile ("apps/web/package-lock.json", or the root's for workspaces); without a scan, the folder's npm
  // lockfile is assumed, as at the root.
  const lockfilePath = row.lockfilePath ?? (dir ? inDir(dir, "package-lock.json") : null);
  const lockKind = LOCKFILES.find((l) => l.path === lockfilePath?.split("/").pop())?.kind ?? null;
  const failed = (f: Failure) =>
    fin({ done: false, failed: f, audit: { message: `Package update PR failed · ${row.app} · ${branch}`, resourceId: appId } }, actor, acc.id);
  const made = await createBranch(acc.token, row.fullName, branch, head.data, base, o);
  if (!made.ok) return failed(made);
  const put = await putManifest(acc.token, row.fullName, branch, base, text, manifest.data.sha, commitMessage(bumps), o, manifestPath);
  if (!put.ok) return failed(put);
  const title = prTitle(bumps, dir);
  const body = (mismatch ? prWarning(mismatch) : "") + prBody(bumps, lockKind, !!auto, dir);
  let pr = await createPull(acc.token, row.fullName, branch, base, title, body, o, { draft: !!mismatch });
  // A private repository on GitHub's free plan can't have draft PRs (422): a normal PR, the warning on top stays.
  let draft = !!mismatch;
  if (mismatch && !pr.ok && pr.status === 422) {
    pr = await createPull(acc.token, row.fullName, branch, base, title, body, o);
    draft = false;
  }
  if (!pr.ok) return failed(pr);
  const how = !mismatch ? "" : draft ? ` Opened as a draft: ${mismatch}` : ` Opened as a normal pull request (this repository can't have drafts), with the warning on top: ${mismatch}`;
  const list = bumps.map((b) => `${b.package} ${b.from} → ${b.to}`).join(", ");
  // For the dedupe and the merge watcher. A failed record doesn't undo the PR (the next scan's dedupe reads GitHub too).
  const sha = await branchHead(acc.token, row.fullName, branch, o).catch(() => null);
  // Watchbell 1.2.2 (D18): the lockfile workflow (the runner or the actions repository set in Settings) took the update,
  // so the result doesn't ask the owner to run npm install.
  let lockfileTaken = false;
  if (sha?.ok && sha.data) {
    await db().insert(dependencyPrs).values({
      repoId, appId, proposalId: proposalId ?? null, number: pr.data.number, branch, baseBranch: base, headSha: sha.data, title: title.slice(0, 200),
      packages: bumps.map((b) => b.package), auto: !!auto, stage: "checks", stageText: stageLine(pr.data.number, "checks"),
    }).onConflictDoNothing().catch(() => console.warn("deps: recording the PR failed"));
    // The VM runner (Stage 9 slice 4, the private edition's registry) updates the lockfile on the PR branch; it skips
    // without a registered runner. The registry is read lazily: its blocks import this file (proposals, merge watcher).
    const { extensions } = await import("@/lib/extensions");
    const job = await extensions.runner?.queueLockfileJob({
      repoId, branch, headSha: sha.data, prNumber: pr.data.number, lockfilePath, targets: bumps.map((b) => ({ name: b.package, version: b.fixed })),
    }).catch(() => { console.warn("deps: queueing the lockfile job failed"); return null; });
    // Or GitHub Actions in the owner's actions repository (no VM needed); never throws, skips when not set up.
    const sent = await dispatchLockfileUpdate(acc.token, { repo: row.fullName, branch, lockfilePath, prNumber: pr.data.number });
    lockfileTaken = job?.queued === true || sent.sent;
  }
  return fin({
    done: true,
    message: `Pull request #${pr.data.number} opened for ${row.app}: ${list}.${lockfileTaken ? "" : ` Run npm install${dir ? ` in ${dir}` : ""} on the branch before merging.`}${how}`,
    audit: { message: `Package update PR opened · ${row.app} · #${pr.data.number}`, resourceId: appId, detail: list },
  }, actor, acc.id);
}

// Automatic security fixes: whether an update-PR proposal may run without asking (before it is approved): a PR-write
// credential exists, and the repository's open advisories give upgrades the policy allows (autoPick). The run itself
// checks again against the real package.json (bumpPrAs with `auto`).
// framework (Watchbell 1.2): a FrameworkVulnerable proposal of that app, judged on its Next.js check instead.
export async function autoBumpReady(repoId: string, severities: DepSeverity[], framework?: { appId: string }): Promise<{ ok: true } | { ok: false; why: string }> {
  if (!isUuid(repoId) || (framework && !isUuid(framework.appId))) return { ok: false, why: "target" };
  const acc = await writeAccount();
  if (!acc || acc === "unreadable") return { ok: false, why: "no write token" };
  const plan = framework ? await frameworkPlanOf(framework.appId) : await dependencyPlanOf(repoId);
  if (!plan) return { ok: false, why: "nothing" };
  const pick = autoPick(plan.upgrades, plan.installed, severities);
  return pick.ok ? { ok: true } : { ok: false, why: pick.why };
}

// Watchbell 1.2.2 (D15): the update-PR proposals (app → its linked repository) whose merge would deploy the base over what
// is live: production was deployed from the CLI, or built from another branch than the base prBase would pick
// (expectedBase: before GitHub is asked whether the branch exists; bumpPrAs checks the real base again), or the last
// reading is older than 30 minutes. App id → the sentence for the proposal's reason. Such a proposal never runs or
// merges automatically.
export async function productionMismatches(pairs: readonly { appId: string; repoId: string }[], now: Date): Promise<Map<string, string>> {
  const want = pairs.filter((p) => isUuid(p.appId) && isUuid(p.repoId));
  const out = new Map<string, string>();
  if (!want.length) return out;
  const rows = await db().select({ appId: appRepos.appId, repoId: appRepos.repoId, meta: resources.meta, defaultBranch: githubRepos.defaultBranch })
    .from(appRepos).innerJoin(resources, eq(resources.id, appRepos.appId)).innerJoin(githubRepos, eq(githubRepos.id, appRepos.repoId))
    .where(inArray(appRepos.appId, [...new Set(want.map((p) => p.appId))])).limit(want.length * 4);
  for (const p of want) {
    const r = rows.find((x) => x.appId === p.appId && x.repoId === p.repoId);
    const meta = (r?.meta ?? {}) as Record<string, unknown>;
    const why = r ? productionMismatch(meta.productionSource, expectedBase(meta, r.defaultBranch ?? null), now) : null;
    if (why) out.set(p.appId, why);
  }
  return out;
}

// ---- proposals for FrameworkVulnerable (Watchbell 1.2) ----
export type FrameworkFix = { repoId: string; from: string; to: string };

// The apps (among these) whose Next.js check is "vulnerable" with a fixed version and that are linked to a live
// repository → that repository and the versions. `depApps`: the apps whose VulnerableDependency alert fires now; when
// the scan of the same repository already offers a fix for a direct `next`, that alert's update PR carries it, so no
// second proposal (and no second Telegram approval) is made for the same package.
export async function frameworkFixes(appIds: string[], depApps: string[] = []): Promise<Map<string, FrameworkFix>> {
  const ids = appIds.filter(isUuid);
  const out = new Map<string, FrameworkFix>();
  if (!ids.length) return out;
  const rows = await db().select({ appId: appRepos.appId, repoId: appRepos.repoId, version: appSecurity.version, status: appSecurity.status, findings: appSecurity.findings })
    .from(appRepos).innerJoin(githubRepos, eq(githubRepos.id, appRepos.repoId)).innerJoin(appSecurity, eq(appSecurity.resourceId, appRepos.appId))
    .where(and(inArray(appRepos.appId, ids), isNull(githubRepos.goneAt), eq(appSecurity.status, "vulnerable"))).limit(ids.length);
  const dep = new Set(depApps);
  const both = rows.filter((r) => dep.has(r.appId));
  const covered = both.length
    ? new Set((await db().selectDistinct({ repoId: dependencyVulns.repoId }).from(dependencyVulns).where(and(
      inArray(dependencyVulns.repoId, [...new Set(both.map((r) => r.repoId))]), isNull(dependencyVulns.resolvedAt), eq(dependencyVulns.package, "next"),
      eq(dependencyVulns.direct, true), isNotNull(dependencyVulns.fixedVersion),
    )).limit(both.length)).map((r) => r.repoId))
    : new Set<string>();
  for (const r of rows) {
    if (dep.has(r.appId) && covered.has(r.repoId)) continue;
    const plan = frameworkPlan({ version: r.version, status: r.status, findings: Array.isArray(r.findings) ? r.findings : [] });
    if (plan) out.set(r.appId, { repoId: r.repoId, from: plan.from, to: plan.to });
  }
  return out;
}
