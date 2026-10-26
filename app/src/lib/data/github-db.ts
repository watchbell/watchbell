import "server-only";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, appRepos, githubRepos, type RepoRun, resources, settings } from "@/db/schema";
import { credentialProblem, statusAfterTest } from "@/lib/accounts";
import { openOrNull } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { autoLinks, packageCandidates, planRepos } from "@/lib/github/links";
import { parseReadGaps, type ReadGaps, readGapsKey, readGapsText } from "@/lib/github/read-gaps";
import { isUuid } from "@/lib/ids";
import { githubUser, latestRun, listRepos, packageName } from "@/lib/providers/github";
import type { FetchOpts } from "@/lib/providers/http";

// B7: the GitHub connection's rows. Every GitHub call is a GET with the read-only token; the token is opened only here.

const MAX_REPOS = 1000; // R8: far beyond MAX_REPO_PAGES × 100
const PARALLEL = 5;

type Account = typeof accounts.$inferSelect;

async function loadAccount(accountId?: string): Promise<{ account: Account; token: string | null; problem: string | null } | null> {
  const where = accountId ? and(eq(accounts.id, accountId), eq(accounts.provider, "github")) : eq(accounts.provider, "github");
  const [account] = await db().select().from(accounts).where(where).orderBy(asc(accounts.createdAt)).limit(1);
  if (!account) return null;
  const token = openOrNull({ ciphertext: account.credentialCiphertext, iv: account.credentialIv }, serverEnv().OPS_ENCRYPTION_KEY);
  return { account, token, problem: credentialProblem(token) };
}

// Runs `fn` over `items`, PARALLEL at a time, starting nothing after `deadline`. Returns how many were started.
async function bounded<T>(items: T[], deadline: number, fn: (item: T) => Promise<void>): Promise<number> {
  let started = 0;
  for (let i = 0; i < items.length; i += PARALLEL) {
    if (Date.now() > deadline) break;
    const batch = items.slice(i, i + PARALLEL);
    started += batch.length;
    await Promise.allSettled(batch.map(fn));
  }
  return started;
}

export type GithubSync = { ok: true; repos: number; linked: number; newLinks: number; notes: string[] } | { ok: false; error: string };

export async function syncGithub(accountId: string | undefined, deadline: number, opts: FetchOpts = {}): Promise<GithubSync> {
  const loaded = await loadAccount(accountId);
  if (!loaded) return { ok: false, error: "GitHub isn't connected." };
  const { account, token, problem } = loaded;
  if (problem || !token) return { ok: false, error: problem ?? "The credential can't be read." };

  const listed = await listRepos(token, opts);
  if (!listed.ok) {
    const change = statusAfterTest({ ok: false, kind: listed.kind === "scope" ? "auth" : listed.kind === "missing" ? "transient" : listed.kind, error: listed.error });
    if (change) await db().update(accounts).set({ ...change, updatedAt: new Date() }).where(eq(accounts.id, account.id));
    return { ok: false, error: listed.error };
  }
  const now = new Date();
  const existing = await db().select({ id: githubRepos.id, externalId: githubRepos.externalId, goneAt: githubRepos.goneAt }).from(githubRepos)
    .where(eq(githubRepos.accountId, account.id)).limit(MAX_REPOS);
  const plan = planRepos(existing, listed.data.repos);
  const fields = (r: (typeof listed.data.repos)[number]) => ({
    owner: r.owner, name: r.name, fullName: r.fullName, defaultBranch: r.defaultBranch, private: r.private, archived: r.archived, htmlUrl: r.htmlUrl, pushedAt: r.pushedAt,
  });
  await db().transaction(async (tx) => {
    for (const u of plan.update) await tx.update(githubRepos).set({ ...fields(u.repo), lastSeenAt: now, goneAt: null, updatedAt: now }).where(eq(githubRepos.id, u.id));
    if (plan.insert.length) {
      await tx.insert(githubRepos).values(plan.insert.map((r) => ({ accountId: account.id, externalId: r.id, ...fields(r) })))
        .onConflictDoNothing({ target: [githubRepos.accountId, githubRepos.externalId] });
    }
    if (plan.gone.length) await tx.update(githubRepos).set({ goneAt: now, updatedAt: now }).where(and(inArray(githubRepos.id, plan.gone), isNull(githubRepos.goneAt)));
  });

  const repos = await db().select().from(githubRepos).where(eq(githubRepos.accountId, account.id)).limit(MAX_REPOS);
  const notes: string[] = [];
  if (listed.data.truncated) notes.push("Only the 300 most recently pushed repositories are listed.");

  // package.json names, for the app page's suggestions (Contents read).
  let contentsDenied = 0;
  await bounded(packageCandidates(repos), deadline, async (r) => {
    const p = await packageName(token, r.fullName, opts);
    if (p.ok) await db().update(githubRepos).set({ packageName: p.data, packageCheckedAt: new Date(), updatedAt: new Date() }).where(eq(githubRepos.id, r.id));
    else if (p.kind === "scope") contentsDenied++;
  });
  if (contentsDenied) notes.push("Some package.json files can't be read: give the token Contents read on those repositories.");

  // Vercel's own Git link wins over a guess (never over the owner's manual choice).
  const apps = await db().select({ id: resources.id, name: resources.name, meta: resources.meta }).from(resources)
    .where(and(eq(resources.kind, "app"), isNull(resources.goneAt))).limit(500);
  const links = await db().select({ appId: appRepos.appId, repoId: appRepos.repoId, source: appRepos.source }).from(appRepos).limit(500);
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const fresh = autoLinks(apps.map((a) => ({ id: a.id, name: a.name, repo: str(a.meta.repo), repoType: str(a.meta.repoType) })), repos, links);
  for (const l of fresh) {
    await db().insert(appRepos).values({ appId: l.appId, repoId: l.repoId, source: "vercel" })
      .onConflictDoUpdate({ target: appRepos.appId, set: { repoId: l.repoId, source: "vercel", updatedAt: new Date() }, setWhere: ne(appRepos.source, "manual") });
  }

  // GitHub Actions status of the linked repositories of this account (Actions read).
  const linked = await db().selectDistinct({ id: githubRepos.id, fullName: githubRepos.fullName, defaultBranch: githubRepos.defaultBranch }).from(appRepos)
    .innerJoin(githubRepos, eq(githubRepos.id, appRepos.repoId))
    .where(and(eq(githubRepos.accountId, account.id), isNull(githubRepos.goneAt))).limit(500);
  let actionsDenied = 0;
  const started = await bounded(linked, deadline, async (r) => {
    const run = await latestRun(token, r.fullName, r.defaultBranch, opts);
    if (run.ok) await saveRun(r.id, run.data);
    else if (run.kind === "scope") actionsDenied++;
  });
  if (actionsDenied) notes.push("Some Actions runs can't be read: give the token Actions read on those repositories.");
  if (started < linked.length) notes.push(`${linked.length - started} Actions status${linked.length - started === 1 ? "" : "es"} left for the next run, time budget used.`);

  const user = await githubUser(token, opts);
  await db().update(accounts).set({ lastSyncAt: now, status: "ok", lastError: null, updatedAt: now, ...(user.ok ? { expiresAt: user.data.expiresAt } : {}) })
    .where(eq(accounts.id, account.id));
  // 1.2.3: what this sync couldn't read, kept for Connections. Before, the daily sync dropped these notes, so a token
  // that lost Actions read on private repositories went unnoticed for days (seen 16–25 Oct).
  const gaps: ReadGaps = { at: now.toISOString(), actionsDenied, contentsDenied };
  await db().insert(settings).values({ key: readGapsKey(account.id), value: gaps })
    .onConflictDoUpdate({ target: settings.key, set: { value: gaps, updatedAt: now } });
  return { ok: true, repos: repos.filter((r) => !r.goneAt).length, linked: linked.length, newLinks: fresh.length, notes };
}

async function saveRun(repoId: string, run: RepoRun): Promise<void> {
  await db().update(githubRepos).set({ actions: run, actionsCheckedAt: new Date(), updatedAt: new Date() }).where(eq(githubRepos.id, repoId));
}

// The daily job's step: nothing without a GitHub connection. Returns the problem to report, or null.
export async function githubDailyStep(deadline: number): Promise<string | null> {
  const [a] = await db().select({ id: accounts.id }).from(accounts).where(eq(accounts.provider, "github")).limit(1);
  if (!a) return null;
  // The run is already late (the sync before took the time): GitHub waits for tomorrow, the steps after keep theirs.
  if (Date.now() > deadline) return "left for the next run, time budget used";
  const r = await syncGithub(a.id, deadline);
  return r.ok ? null : r.error;
}

// Connections: repositories and linked apps per GitHub account, and what the last sync couldn't read (1.2.3).
export async function githubCounts(): Promise<Map<string, { repos: number; linked: number; gaps: string | null }>> {
  const repos = await db().select({ accountId: githubRepos.accountId, n: sql<number>`count(*)::int` }).from(githubRepos)
    .where(isNull(githubRepos.goneAt)).groupBy(githubRepos.accountId);
  // The oldest Actions read among the linked repositories: when Actions can't be read, that is when it last worked.
  const linked = await db().select({ accountId: githubRepos.accountId, n: sql<number>`count(*)::int`, oldest: sql<string | null>`min(${githubRepos.actionsCheckedAt})` })
    .from(appRepos).innerJoin(githubRepos, eq(githubRepos.id, appRepos.repoId)).groupBy(githubRepos.accountId);
  const gapRows = repos.length
    ? await db().select({ key: settings.key, value: settings.value }).from(settings).where(inArray(settings.key, repos.map((r) => readGapsKey(r.accountId)))).limit(repos.length)
    : [];
  return new Map(repos.map((r) => {
    const l = linked.find((x) => x.accountId === r.accountId);
    const gaps = parseReadGaps(gapRows.find((g) => g.key === readGapsKey(r.accountId))?.value);
    return [r.accountId, { repos: r.n, linked: l?.n ?? 0, gaps: readGapsText(gaps, l?.oldest ? new Date(l.oldest) : null) }];
  }));
}

export type RepoOption = { id: string; fullName: string; archived: boolean };
type RepoRow = typeof githubRepos.$inferSelect;
export type AppRepoView = {
  connected: boolean;
  link: { source: "vercel" | "manual"; repo: RepoRow } | null;
  // The live repositories, for the page's suggestion (suggestRepo) and the owner's Link/Change choices.
  repos: Pick<RepoRow, "id" | "name" | "fullName" | "packageName" | "archived" | "goneAt" | "pushedAt">[];
  options: RepoOption[];
  suggestion?: { repoId: string; fullName: string; why: "name" | "package" } | null;
};

// App page → Repository: the link and the repositories to suggest or choose from. Read with the page's other reads, so
// the suggestion is made on the page once the app's name is known.
export async function appRepoView(appId: string): Promise<AppRepoView> {
  const empty: AppRepoView = { connected: false, link: null, repos: [], options: [] };
  if (!isUuid(appId)) return empty;
  const [acc] = await db().select({ id: accounts.id }).from(accounts).where(eq(accounts.provider, "github")).limit(1);
  const [row] = await db().select({ l: appRepos, r: githubRepos }).from(appRepos).innerJoin(githubRepos, eq(githubRepos.id, appRepos.repoId))
    .where(eq(appRepos.appId, appId)).limit(1);
  if (!acc) return { ...empty, link: row ? { source: row.l.source, repo: row.r } : null };
  const repos = await db().select({
    id: githubRepos.id, name: githubRepos.name, fullName: githubRepos.fullName, packageName: githubRepos.packageName,
    archived: githubRepos.archived, goneAt: githubRepos.goneAt, pushedAt: githubRepos.pushedAt,
  }).from(githubRepos).where(isNull(githubRepos.goneAt)).orderBy(desc(githubRepos.pushedAt)).limit(MAX_REPOS);
  return {
    connected: true,
    link: row ? { source: row.l.source, repo: row.r } : null,
    repos,
    options: repos.map((r) => ({ id: r.id, fullName: r.fullName, archived: r.archived })),
  };
}

// The owner's choice (B7): link to a repository (manual, which a sync never overwrites) or unlink (null).
export async function linkAppRepo(appId: string, repoId: string | null, actorUserId: string): Promise<{ ok: true; message: string; app: string; repo: string | null } | { ok: false; error: string }> {
  if (!isUuid(appId) || (repoId !== null && !isUuid(repoId))) return { ok: false, error: "That app or repository no longer exists." };
  const [app] = await db().select({ id: resources.id, name: resources.name }).from(resources).where(and(eq(resources.id, appId), eq(resources.kind, "app"))).limit(1);
  if (!app) return { ok: false, error: "That app no longer exists." };
  if (repoId === null) {
    const gone = await db().delete(appRepos).where(eq(appRepos.appId, appId)).returning({ appId: appRepos.appId });
    return gone.length ? { ok: true, message: `${app.name} is no longer linked to a repository.`, app: app.name, repo: null } : { ok: false, error: `${app.name} has no repository linked.` };
  }
  const [repo] = await db().select({ id: githubRepos.id, fullName: githubRepos.fullName }).from(githubRepos).where(and(eq(githubRepos.id, repoId), isNull(githubRepos.goneAt))).limit(1);
  if (!repo) return { ok: false, error: "That repository is no longer shared with the GitHub token. Sync GitHub and try again." };
  await db().insert(appRepos).values({ appId, repoId, source: "manual", linkedBy: actorUserId })
    .onConflictDoUpdate({ target: appRepos.appId, set: { repoId, source: "manual", linkedBy: actorUserId, updatedAt: new Date() } });
  return { ok: true, message: `${app.name} is linked to ${repo.fullName}.`, app: app.name, repo: repo.fullName };
}

// App page → Repository → Refresh: the linked repository's latest Actions run, now.
export async function refreshAppActions(appId: string, opts: FetchOpts = {}): Promise<{ ok: true; run: RepoRun; repo: string } | { ok: false; error: string }> {
  if (!isUuid(appId)) return { ok: false, error: "That app no longer exists." };
  const [row] = await db().select({ r: githubRepos }).from(appRepos).innerJoin(githubRepos, eq(githubRepos.id, appRepos.repoId)).where(eq(appRepos.appId, appId)).limit(1);
  if (!row) return { ok: false, error: "Link a repository first." };
  const loaded = await loadAccount(row.r.accountId);
  if (!loaded?.token) return { ok: false, error: loaded?.problem ?? "GitHub isn't connected." };
  const run = await latestRun(loaded.token, row.r.fullName, row.r.defaultBranch, opts);
  if (!run.ok) return { ok: false, error: run.error };
  await saveRun(row.r.id, run.data);
  return { ok: true, run: run.data, repo: row.r.fullName };
}

// Stage 9 slice 3 (the office's Dev officer): the app's linked repository with the opened read-only token, for GET reads
// of its files. The token never leaves the server; callers pass it only to the GitHub adapter.
export type RepoRead = { ok: true; fullName: string; defaultBranch: string | null; token: string } | { ok: false; reason: "no-repo" | "no-token"; error: string };

export async function repoReadAccess(appId: string): Promise<RepoRead> {
  if (!isUuid(appId)) return { ok: false, reason: "no-repo", error: "That app no longer exists." };
  const [row] = await db().select({ r: githubRepos }).from(appRepos).innerJoin(githubRepos, eq(githubRepos.id, appRepos.repoId))
    .where(and(eq(appRepos.appId, appId), isNull(githubRepos.goneAt))).limit(1);
  if (!row) return { ok: false, reason: "no-repo", error: "This app isn't linked to a GitHub repository yet." };
  const loaded = await loadAccount(row.r.accountId);
  if (!loaded?.token) return { ok: false, reason: "no-token", error: "The GitHub token can't be read; check the GitHub connection." };
  return { ok: true, fullName: row.r.fullName, defaultBranch: row.r.defaultBranch, token: loaded.token };
}

// Whether the app has a linked repository (the app page's Dev notes card).
export async function hasLinkedRepo(appId: string): Promise<boolean> {
  if (!isUuid(appId)) return false;
  const [row] = await db().select({ id: appRepos.appId }).from(appRepos).innerJoin(githubRepos, eq(githubRepos.id, appRepos.repoId))
    .where(and(eq(appRepos.appId, appId), isNull(githubRepos.goneAt))).limit(1);
  return !!row;
}
