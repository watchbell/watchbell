import "server-only";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, appRepos, dependencyPrs, dependencyScans, dependencyVulns, type DepSeverity, githubRepos, resources } from "@/db/schema";
import type { ActionResult } from "@/lib/action";
import { openOrNull } from "@/lib/crypto";
import { autoPick, installedOf, overlappingPr, sameMajor } from "@/lib/deps/auto-policy";
import { applyBumps, branchName, commitMessage, isOwnBranch, planBumps, prBody, prTitle } from "@/lib/deps/bump";
import { LOCKFILES, minVersion } from "@/lib/deps/lockfile";
import { stageLine } from "@/lib/deps/pr-watch";
import { upgradesFor } from "@/lib/deps/plan";
import { serverEnv } from "@/lib/env";
import { isUuid } from "@/lib/ids";
import { branchHead, createBranch, createPull, manifestAt, openPull, openWatchpostPulls, putManifest, repoInfo } from "@/lib/providers/github-write";
import type { Failure, FetchOpts } from "@/lib/providers/http";
import { type ActionOutcome, STALE } from "@/lib/provider-actions";
import { type Actor, finish, type Finisher, targetQuota } from "./provider-action-db";
import { dispatchLockfileUpdate } from "./actions-lockfile-db";

// Stage 9 slice 5: "Open package update PR", run only from an approved office proposal (risky: the owner always decides).
// With the separate GitHub PR-write credential (provider github_write): a new watchpost/deps-… branch from the default
// branch's head, package.json with the vulnerable direct packages raised to their fixed versions, and a pull request in
// English text that asks for `npm install` before merging. Never a push to the default branch (github-write.ts refuses).
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
export type BumpOpts = FetchOpts & { auto?: { severities: DepSeverity[] }; proposalId?: string | null };
const MAJOR_WHY = { severity: "no package at the selected severity", major: "an update jumps a major version", nothing: "nothing can be updated" } as const;

export async function bumpPrAs(actor: Actor, appId: string, repoId: string, fin: Finisher = finish, opts: BumpOpts = {}): Promise<ActionResult> {
  if (!isUuid(appId) || !isUuid(repoId)) return fin(refuse("Something in that request wasn't valid."), actor, "");
  const quota = await targetQuota(actor.id, "github_bump_pr", appId);
  if (quota) return fin(refuse(quota), actor, "");
  const acc = await writeAccount();
  if (acc === null) return fin(refuse(NEED_WRITE_TOKEN), actor, "");
  if (acc === "unreadable") return fin(refuse("Can't read the stored GitHub PR-write credential. Replace it on Connections."), actor, "");

  // The app must still be linked to that repository (the proposal's target), and the repository still shared.
  const [row] = await db().select({ app: resources.name, fullName: githubRepos.fullName, owner: githubRepos.owner, goneAt: githubRepos.goneAt, lockfilePath: dependencyScans.lockfilePath })
    .from(appRepos).innerJoin(githubRepos, eq(githubRepos.id, appRepos.repoId)).innerJoin(resources, eq(resources.id, appRepos.appId))
    .leftJoin(dependencyScans, eq(dependencyScans.repoId, appRepos.repoId))
    .where(and(eq(appRepos.appId, appId), eq(appRepos.repoId, repoId))).limit(1);
  if (!row || row.goneAt) return fin(refuse(STALE), actor, acc.id);
  const open = await db().select({
    package: dependencyVulns.package, installedVersion: dependencyVulns.installedVersion, fixedVersion: dependencyVulns.fixedVersion, vulnId: dependencyVulns.vulnId,
    aliases: dependencyVulns.aliases, severity: dependencyVulns.severity, direct: dependencyVulns.direct,
  }).from(dependencyVulns).where(and(eq(dependencyVulns.repoId, repoId), isNull(dependencyVulns.resolvedAt))).limit(2_000);
  let upgrades = upgradesFor(open);
  if (!upgrades.length) return fin(refuse(`Nothing to update in ${row.app}: no direct package has a fixed version for its open advisories.`), actor, acc.id);
  if (opts.auto) {
    const pick = autoPick(upgrades, installedOf(open), opts.auto.severities);
    if (!pick.ok) return fin(refuse(`Automatic PR not opened: ${MAJOR_WHY[pick.why]}. The proposal waits for your approval.`), actor, acc.id);
    upgrades = pick.upgrades;
  }

  const { auto, proposalId, ...fetchOpts } = opts;
  const o: FetchOpts = { timeoutMs: 8_000, ...fetchOpts };
  const info = await repoInfo(acc.token, row.fullName, o);
  if (!info.ok) return fin({ done: false, failed: info, audit: { message: `Package update PR failed · ${row.app}`, resourceId: appId } }, actor, acc.id);
  const base = info.data.defaultBranch;
  const head = await branchHead(acc.token, row.fullName, base, o);
  if (!head.ok) return fin({ done: false, failed: head, audit: { message: `Package update PR failed · ${row.app}`, resourceId: appId } }, actor, acc.id);
  if (!head.data) return fin(refuse(`The default branch ${base} wasn't found.`), actor, acc.id);
  const manifest = await manifestAt(acc.token, row.fullName, head.data, o);
  if (!manifest.ok) return fin({ done: false, failed: manifest, audit: { message: `Package update PR failed · ${row.app}`, resourceId: appId } }, actor, acc.id);
  if (!manifest.data) return fin(refuse("There is no package.json at the repository root."), actor, acc.id);
  const bumps = planBumps(manifest.data.text, upgrades);
  if (!bumps?.length) return fin(refuse(`package.json in ${row.app} already allows the fixed versions (or its ranges can't be rewritten). Run npm install there.`), actor, acc.id);
  if (auto) {
    // The real ranges in package.json: each bump must still stay within its major.
    const jump = bumps.find((b) => { const from = minVersion(b.from); return !from || !sameMajor(from, b.fixed); });
    if (jump) return fin(refuse(`Automatic PR not opened: ${jump.package} ${jump.from} → ${jump.to} jumps a major version. The proposal waits for your approval.`), actor, acc.id);
  }
  const text = applyBumps(manifest.data.text, bumps);
  if (!text) return fin(refuse("package.json couldn't be edited safely."), actor, acc.id);
  const branch = branchName(bumps);
  if (!isOwnBranch(branch, base)) return fin(refuse("Refused: the PR branch would be the default branch."), actor, acc.id);

  // The same bumps were proposed before: the open PR is the answer.
  const existing = await openPull(acc.token, row.fullName, row.owner, branch, base, o);
  if (existing.ok && existing.data) return { ok: true, message: `Pull request #${existing.data.number} for these updates is already open.` };
  // Never two open Watchbell PRs for one repository and package (the packages of our own PRs are stored; others are read
  // from their title).
  const openPrs = await openWatchpostPulls(acc.token, row.fullName, o);
  if (!openPrs.ok) return fin({ done: false, failed: openPrs, audit: { message: `Package update PR failed · ${row.app}`, resourceId: appId } }, actor, acc.id);
  if (openPrs.data.length) {
    const ours = await db().select({ number: dependencyPrs.number, packages: dependencyPrs.packages }).from(dependencyPrs)
      .where(and(eq(dependencyPrs.repoId, repoId), inArray(dependencyPrs.number, openPrs.data.map((p) => p.number))));
    const known = new Map(ours.map((r) => [r.number, r.packages]));
    const clash = overlappingPr(bumps.map((b) => b.package), openPrs.data.map((p) => ({ number: p.number, branch: p.branch, title: p.title, packages: known.get(p.number) ?? null })));
    if (clash) return fin(refuse(`Pull request #${clash.number} for the same package is already open in ${row.app}. Merge or close it first.`), actor, acc.id);
  }
  const had = await branchHead(acc.token, row.fullName, branch, o);
  if (had.ok && had.data) return fin(refuse(`Branch ${branch} already exists without an open pull request. Delete it on GitHub, then ask again.`), actor, acc.id);

  const lockKind = LOCKFILES.find((l) => l.path === row.lockfilePath)?.kind ?? null;
  const failed = (f: Failure) =>
    fin({ done: false, failed: f, audit: { message: `Package update PR failed · ${row.app} · ${branch}`, resourceId: appId } }, actor, acc.id);
  const made = await createBranch(acc.token, row.fullName, branch, head.data, base, o);
  if (!made.ok) return failed(made);
  const put = await putManifest(acc.token, row.fullName, branch, base, text, manifest.data.sha, commitMessage(bumps), o);
  if (!put.ok) return failed(put);
  const pr = await createPull(acc.token, row.fullName, branch, base, prTitle(bumps), prBody(bumps, lockKind, !!auto), o);
  if (!pr.ok) return failed(pr);
  const list = bumps.map((b) => `${b.package} ${b.from} → ${b.to}`).join(", ");
  // For the dedupe and the merge watcher. A failed record doesn't undo the PR (the next scan's dedupe reads GitHub too).
  const sha = await branchHead(acc.token, row.fullName, branch, o).catch(() => null);
  if (sha?.ok && sha.data) {
    await db().insert(dependencyPrs).values({
      repoId, appId, proposalId: proposalId ?? null, number: pr.data.number, branch, baseBranch: base, headSha: sha.data, title: prTitle(bumps).slice(0, 200),
      packages: bumps.map((b) => b.package), auto: !!auto, stage: "checks", stageText: stageLine(pr.data.number, "checks"),
    }).onConflictDoNothing().catch(() => console.warn("deps: recording the PR failed"));
    // The VM runner (Stage 9 slice 4, the private edition's registry) updates the lockfile on the PR branch; it skips
    // without a registered runner. The registry is read lazily: its blocks import this file (proposals, merge watcher).
    const { extensions } = await import("@/lib/extensions");
    await extensions.runner?.queueLockfileJob({
      repoId, branch, headSha: sha.data, prNumber: pr.data.number, lockfilePath: row.lockfilePath ?? null, targets: bumps.map((b) => ({ name: b.package, version: b.fixed })),
    }).catch(() => console.warn("deps: queueing the lockfile job failed"));
    // Or GitHub Actions in the owner's actions repository (no VM needed); never throws, skips when not set up.
    await dispatchLockfileUpdate(acc.token, { repo: row.fullName, branch, lockfilePath: row.lockfilePath ?? null, prNumber: pr.data.number });
  }
  return fin({
    done: true,
    message: `Pull request #${pr.data.number} opened for ${row.app}: ${list}. Run npm install on the branch before merging.`,
    audit: { message: `Package update PR opened · ${row.app} · #${pr.data.number}`, resourceId: appId, detail: list },
  }, actor, acc.id);
}

// Automatic security fixes: whether an update-PR proposal may run without asking (before it is approved): a PR-write
// credential exists, and the repository's open advisories give upgrades the policy allows (autoPick). The run itself
// checks again against the real package.json (bumpPrAs with `auto`).
export async function autoBumpReady(repoId: string, severities: DepSeverity[]): Promise<{ ok: true } | { ok: false; why: string }> {
  if (!isUuid(repoId)) return { ok: false, why: "target" };
  const acc = await writeAccount();
  if (!acc || acc === "unreadable") return { ok: false, why: "no write token" };
  const open = await db().select({
    package: dependencyVulns.package, installedVersion: dependencyVulns.installedVersion, fixedVersion: dependencyVulns.fixedVersion, vulnId: dependencyVulns.vulnId,
    aliases: dependencyVulns.aliases, severity: dependencyVulns.severity, direct: dependencyVulns.direct,
  }).from(dependencyVulns).where(and(eq(dependencyVulns.repoId, repoId), isNull(dependencyVulns.resolvedAt))).limit(2_000);
  const pick = autoPick(upgradesFor(open), installedOf(open), severities);
  return pick.ok ? { ok: true } : { ok: false, why: pick.why };
}
