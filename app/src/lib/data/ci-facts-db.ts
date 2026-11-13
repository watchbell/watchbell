import "server-only";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { appRepos, githubRepos, type RepoRun } from "@/db/schema";
import type { CiFact } from "@/lib/alerts/facts";
import { isUuid } from "@/lib/ids";

// Watchbell 1.4: the alert rule CiFailing's facts — each app's linked repository and the default branch's latest
// Actions run the daily GitHub sync stored (lib/data/github-db.ts saveRun). Repositories never read are left out, so a
// token without Actions: Read leaves the list empty and the rule unevaluated.

// The sync runs daily and keeps the last run it could read when Actions read is lost (review, 1.4): a run not read
// again within two days is unknown, so an old failure neither pages nor resolves.
export const CI_FRESH_MS = 2 * 86_400_000;

type CiRow = { appId: string; repo: string; branch: string | null; run: RepoRun | null; checkedAt: Date | null; goneAt: Date | null };

export function ciFactsFrom(rows: CiRow[], now: Date): CiFact[] {
  return rows.filter((r) => r.run && !r.goneAt).map((r) => ({
    appId: r.appId, repo: r.repo, branch: r.branch,
    run: r.checkedAt && now.getTime() - r.checkedAt.getTime() <= CI_FRESH_MS ? r.run : null,
  }));
}

export async function ciFacts(appIds: string[], now = new Date()): Promise<CiFact[]> {
  const ids = appIds.filter(isUuid);
  if (!ids.length) return [];
  const rows = await db().select({
    appId: appRepos.appId, repo: githubRepos.fullName, branch: githubRepos.defaultBranch, run: githubRepos.actions,
    checkedAt: githubRepos.actionsCheckedAt, goneAt: githubRepos.goneAt,
  }).from(appRepos).innerJoin(githubRepos, eq(githubRepos.id, appRepos.repoId)).where(inArray(appRepos.appId, ids));
  return ciFactsFrom(rows, now);
}
