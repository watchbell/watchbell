import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, appRepos, dependencyScans, dependencyVulns, githubRepos, resources } from "@/db/schema";
import { openOrNull } from "@/lib/crypto";
import type { AppDepsView } from "@/lib/data/deps-db";
import { rank } from "@/lib/deps/plan";
import { serverEnv } from "@/lib/env";
import { FILE_VIEW_MAX, type LinkedApp, linkedAppsByRepo, type RepoListItem } from "@/lib/github/browse";
import { TtlCache } from "@/lib/github/ttl-cache";
import { isUuid } from "@/lib/ids";
import { fileText, repoTree, type TreeEntry } from "@/lib/providers/github";
import { branches, commits, readme, repoInfo, repoLanguages, runs } from "@/lib/providers/github-browse";
import type { Result } from "@/lib/providers/http";
import { actionsStatus } from "@/lib/view/github";

// GitHub → Repositories (owner 16 Oct): the synced repositories (ops.github_repos, Stage 7) with their linked apps, the
// dependency scan's open advisories (Stage 9 slice 5) and the latest Actions status the sync read. The detail page's
// GitHub reads go through here: the read-only token is opened only in this file and never leaves the server; every
// read is a GET, cached in memory for a short time (TtlCache), and paused while GitHub's rate limit is used up.

const MAX_REPOS = 1000;
const cache = new TtlCache(300);
export const resetRepoCache = () => cache.clear();

const TTL = { languages: 15 * 60_000, info: 5 * 60_000, tree: 10 * 60_000, readme: 10 * 60_000, file: 5 * 60_000, commits: 2 * 60_000, branches: 5 * 60_000, runs: 2 * 60_000 };

async function tokenFor(accountId: string): Promise<string | null> {
  const [a] = await db().select({ c: accounts.credentialCiphertext, iv: accounts.credentialIv }).from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.provider, "github"))).limit(1);
  return a ? openOrNull({ ciphertext: a.c, iv: a.iv }, serverEnv().OPS_ENCRYPTION_KEY) : null;
}

async function firstAccount(): Promise<string | null> {
  const [a] = await db().select({ id: accounts.id }).from(accounts).where(eq(accounts.provider, "github")).orderBy(asc(accounts.createdAt)).limit(1);
  return a?.id ?? null;
}

async function appsFor(repoIds: string[] | null): Promise<Map<string, LinkedApp[]>> {
  const links = await db().select({ appId: appRepos.appId, repoId: appRepos.repoId, name: resources.name }).from(appRepos)
    .innerJoin(resources, eq(resources.id, appRepos.appId))
    .where(and(eq(resources.kind, "app"), isNull(resources.goneAt), repoIds ? inArray(appRepos.repoId, repoIds) : undefined)).limit(1000);
  return linkedAppsByRepo(links, links.map((l) => ({ id: l.appId, name: l.name })));
}

export type RepoList = { connected: boolean; items: RepoListItem[]; languageNote: string | null };

// The list page: every live synced repository, newest push first.
export async function listRepoItems(): Promise<RepoList> {
  const account = await firstAccount();
  const rows = await db().select({
    id: githubRepos.id, accountId: githubRepos.accountId, fullName: githubRepos.fullName, private: githubRepos.private, archived: githubRepos.archived,
    defaultBranch: githubRepos.defaultBranch, pushedAt: githubRepos.pushedAt, actions: githubRepos.actions,
  }).from(githubRepos).where(isNull(githubRepos.goneAt)).orderBy(desc(githubRepos.pushedAt)).limit(MAX_REPOS);
  if (!rows.length) return { connected: account !== null, items: [], languageNote: null };
  const [apps, counts, scanned] = await Promise.all([
    appsFor(null),
    db().select({ repoId: dependencyVulns.repoId, n: sql<number>`count(*)::int` }).from(dependencyVulns).where(isNull(dependencyVulns.resolvedAt)).groupBy(dependencyVulns.repoId),
    db().select({ repoId: dependencyScans.repoId }).from(dependencyScans).where(isNotNull(dependencyScans.scannedAt)),
  ]);
  const vulns = new Map(counts.map((c) => [c.repoId, c.n]));
  const scannedSet = new Set(scanned.map((s) => s.repoId));
  // The language comes from GitHub's listing (cached 15 min); without it the column stays empty.
  let languages = new Map<string, string>();
  let languageNote: string | null = null;
  const token = account ? await tokenFor(account) : null;
  if (token) {
    const l = await cache.get(`languages:${account}`, TTL.languages, () => repoLanguages(token));
    if (l.ok) languages = l.data;
    else languageNote = `Languages aren't shown: ${l.error}`;
  }
  return {
    connected: account !== null,
    languageNote,
    items: rows.map((r) => ({
      id: r.id, fullName: r.fullName, private: r.private, archived: r.archived, defaultBranch: r.defaultBranch, pushedAt: r.pushedAt?.toISOString() ?? null,
      language: languages.get(r.fullName.toLowerCase()) ?? null, apps: apps.get(r.id) ?? [],
      advisories: scannedSet.has(r.id) ? (vulns.get(r.id) ?? 0) : null,
      actions: r.actions ? actionsStatus(r.actions, r.defaultBranch) : null,
    })),
  };
}

type RepoRow = typeof githubRepos.$inferSelect;
export type RepoHead = { repo: RepoRow; apps: LinkedApp[]; ref: string };

// The detail page's repository (a live or gone row) and its linked apps; null for an unknown id.
export async function repoHead(id: string): Promise<RepoHead | null> {
  if (!isUuid(id)) return null;
  const [repo] = await db().select().from(githubRepos).where(eq(githubRepos.id, id)).limit(1);
  if (!repo) return null;
  const apps = await appsFor([repo.id]);
  return { repo, apps: apps.get(repo.id) ?? [], ref: repo.defaultBranch ?? "HEAD" };
}

const NO_TOKEN: Result<never> = { ok: false, kind: "auth", error: "The GitHub token can't be read. Check the GitHub connection on Connections." };

// One cached GitHub read for a repository, with its account's token.
async function read<T>(repo: RepoRow, what: string, ttl: number, fn: (token: string) => Promise<Result<T>>): Promise<Result<T>> {
  if (repo.goneAt) return { ok: false, kind: "missing", error: "This repository is no longer shared with the GitHub token." };
  return cache.get(`${repo.id}:${what}`, ttl, async () => {
    const token = await tokenFor(repo.accountId);
    return token ? fn(token) : NO_TOKEN;
  });
}

export const repoInfoOf = (h: RepoHead) => read(h.repo, "info", TTL.info, (t) => repoInfo(t, h.repo.fullName));
export const readmeOf = (h: RepoHead) => read(h.repo, `readme@${h.ref}`, TTL.readme, (t) => readme(t, h.repo.fullName, h.ref, FILE_VIEW_MAX));
export const treeOf = (h: RepoHead): Promise<Result<{ entries: TreeEntry[]; truncated: boolean }>> => read(h.repo, `tree@${h.ref}`, TTL.tree, (t) => repoTree(t, h.repo.fullName, h.ref));
export const commitsOf = (h: RepoHead) => read(h.repo, `commits@${h.ref}`, TTL.commits, (t) => commits(t, h.repo.fullName, h.ref, 20));
export const branchesOf = (h: RepoHead) => read(h.repo, "branches", TTL.branches, (t) => branches(t, h.repo.fullName));
export const runsOf = (h: RepoHead) => read(h.repo, "runs", TTL.runs, (t) => runs(t, h.repo.fullName, 10));
// One file's text (the caller checked the path against the tree and the never-read rule first). Null: binary or too big.
export const fileOf = (h: RepoHead, path: string) => read(h.repo, `file@${h.ref}:${path}`, TTL.file, (t) => fileText(t, h.repo.fullName, path, h.ref, FILE_VIEW_MAX));

// Dependencies tab: the scan's rows for this repository, in the app page card's shape (lib/data/deps-db.ts).
export async function repoDepsView(repo: Pick<RepoRow, "id" | "fullName">): Promise<AppDepsView> {
  const [[scan], vulns] = await Promise.all([
    db().select({ scannedAt: dependencyScans.scannedAt, lockfilePath: dependencyScans.lockfilePath, packageCount: dependencyScans.packageCount, error: dependencyScans.error, note: dependencyScans.note })
      .from(dependencyScans).where(eq(dependencyScans.repoId, repo.id)).limit(1),
    db().select({
      package: dependencyVulns.package, installedVersion: dependencyVulns.installedVersion, vulnId: dependencyVulns.vulnId, severity: dependencyVulns.severity,
      fixedVersion: dependencyVulns.fixedVersion, summary: dependencyVulns.summary, aliases: dependencyVulns.aliases, dev: dependencyVulns.dev, direct: dependencyVulns.direct,
      firstSeenAt: dependencyVulns.firstSeenAt,
    }).from(dependencyVulns).where(and(eq(dependencyVulns.repoId, repo.id), isNull(dependencyVulns.resolvedAt))).limit(2000),
  ]);
  vulns.sort((a, b) => rank(a.severity) - rank(b.severity) || (a.package < b.package ? -1 : a.package > b.package ? 1 : 0) || (a.vulnId < b.vulnId ? -1 : 1));
  return { repo: { id: repo.id, fullName: repo.fullName }, scan: scan ?? null, vulns, writeConnected: true };
}
