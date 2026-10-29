import "server-only";
import { and, desc, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "@/db/client";
import { appRepos, deployments, githubRepos } from "@/db/schema";
import { githubReadToken } from "@/lib/data/deps-db";
import { compareCommits, type Commit } from "@/lib/providers/github-browse";
import type { Result } from "@/lib/providers/http";
import type { ReleaseNotes } from "@/lib/view/release-notes";

export type { ReleaseNotes } from "@/lib/view/release-notes";

// Watchbell 1.3 What changed (on demand only): the commits between a production deployment and the production
// deployment before it (the newest READY one of the same app with a commit, created earlier), from GitHub's compare.
// At most the newest 50 are kept. Reads are injected so the tests need no database or network.

const KEEP = 50;

export type ReleaseNotesDeps = {
  deployment(appId: string, externalId: string): Promise<{ commitSha: string | null; createdAt: Date } | null>;
  previous(appId: string, before: Date): Promise<{ commitSha: string } | null>;
  repo(appId: string): Promise<{ fullName: string } | null>;
  githubToken(): Promise<string | null>;
  compare(token: string, fullName: string, base: string, head: string): Promise<Result<{ commits: Commit[]; total: number }>>;
};

const DEFAULT_DEPS: ReleaseNotesDeps = {
  async deployment(appId, externalId) {
    const [d] = await db().select({ commitSha: deployments.commitSha, createdAt: deployments.createdAtProvider }).from(deployments)
      .where(and(eq(deployments.resourceId, appId), eq(deployments.externalId, externalId), eq(deployments.target, "production"))).limit(1);
    return d ?? null;
  },
  async previous(appId, before) {
    const [d] = await db().select({ commitSha: deployments.commitSha }).from(deployments)
      .where(and(eq(deployments.resourceId, appId), eq(deployments.target, "production"), eq(deployments.state, "ready"),
        isNotNull(deployments.commitSha), lt(deployments.createdAtProvider, before)))
      .orderBy(desc(deployments.createdAtProvider)).limit(1);
    return d?.commitSha ? { commitSha: d.commitSha } : null;
  },
  async repo(appId) {
    const [row] = await db().select({ fullName: githubRepos.fullName }).from(appRepos)
      .innerJoin(githubRepos, eq(githubRepos.id, appRepos.repoId)).where(eq(appRepos.appId, appId)).limit(1);
    return row ?? null;
  },
  async githubToken() {
    const t = await githubReadToken();
    return "token" in t ? t.token : null;
  },
  compare: (token, fullName, base, head) => compareCommits(token, fullName, base, head),
};

const empty = (from: string | null, to: string, note: string): ReleaseNotes => ({ from, to, commits: [], total: 0, cut: false, note });

export async function releaseNotesFor(appId: string, externalId: string, deps: ReleaseNotesDeps = DEFAULT_DEPS): Promise<{ ok: true; data: ReleaseNotes } | { ok: false; error: string }> {
  const d = await deps.deployment(appId, externalId);
  if (!d) return { ok: false, error: "That deployment isn't a production deployment of this app." };
  if (!d.commitSha) return { ok: true, data: empty(null, "", "This deployment wasn't built from a Git commit.") };
  const prev = await deps.previous(appId, d.createdAt);
  if (!prev) return { ok: true, data: empty(null, d.commitSha, "This is the first production deployment the console has seen.") };
  if (prev.commitSha === d.commitSha) return { ok: true, data: empty(prev.commitSha, d.commitSha, "Same commit as the previous production deployment (a redeploy).") };
  const repo = await deps.repo(appId);
  if (!repo) return { ok: false, error: "Link a repository to see what changed." };
  const token = await deps.githubToken();
  if (!token) return { ok: false, error: "GitHub isn't connected, or its token can't be read." };
  const r = await deps.compare(token, repo.fullName, prev.commitSha, d.commitSha);
  if (!r.ok) return { ok: false, error: r.kind === "missing" ? "GitHub can't compare these commits (the history may have been rewritten)." : `Couldn't read the commits: ${r.error}` };
  return { ok: true, data: { from: prev.commitSha, to: d.commitSha, commits: r.data.commits.slice(0, KEEP), total: r.data.total, cut: r.data.total > KEEP || r.data.commits.length > KEEP, note: null } };
}
