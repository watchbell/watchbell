import type { GhRepo } from "@/lib/providers/github";

// B7: how repositories become rows and apps get linked to them. Pure: the db layer (lib/data/github-db.ts) feeds it.

export type StoredRepo = {
  id: string; externalId: string; name: string; fullName: string; packageName: string | null; archived: boolean;
  pushedAt: Date | null; packageCheckedAt: Date | null; goneAt: Date | null;
};
export type LinkRow = { appId: string; repoId: string; source: "vercel" | "manual" };
export type AppForLink = { id: string; name: string; repo: string | null; repoType: string | null };

// Matched on GitHub's repository id, so a renamed repository keeps its row and its links.
export function planRepos(existing: Pick<StoredRepo, "id" | "externalId" | "goneAt">[], found: GhRepo[]): { insert: GhRepo[]; update: { id: string; repo: GhRepo }[]; gone: string[] } {
  const byId = new Map(existing.map((e) => [e.externalId, e]));
  const seen = new Set(found.map((f) => f.id));
  return {
    insert: found.filter((f) => !byId.has(f.id)),
    update: found.filter((f) => byId.has(f.id)).map((f) => ({ id: byId.get(f.id)!.id, repo: f })),
    gone: existing.filter((e) => !seen.has(e.externalId) && !e.goneAt).map((e) => e.id),
  };
}

const lower = (s: string) => s.trim().toLowerCase();

// An app whose Vercel project is linked to a GitHub repository (Vercel's link.repo, kept by Sync in the app's meta as
// "org/repo") is linked to that repository automatically. The owner's own choice (manual) is never overwritten, and a
// link that is already right is not rewritten.
export function autoLinks(apps: AppForLink[], repos: Pick<StoredRepo, "id" | "fullName" | "goneAt">[], links: LinkRow[]): { appId: string; repoId: string }[] {
  const byName = new Map(repos.filter((r) => !r.goneAt).map((r) => [lower(r.fullName), r.id]));
  const current = new Map(links.map((l) => [l.appId, l]));
  const out: { appId: string; repoId: string }[] = [];
  for (const app of apps) {
    if (app.repoType !== "github" || !app.repo) continue;
    const repoId = byName.get(lower(app.repo));
    if (!repoId) continue;
    const link = current.get(app.id);
    if (link?.source === "manual" || link?.repoId === repoId) continue;
    out.push({ appId: app.id, repoId });
  }
  return out;
}

// "@scope/name" → "name": a scoped package names the app by its last part.
const bare = (pkg: string) => lower(pkg.replace(/^@[^/]+\//, ""));

// The repository the app page suggests when there is no link yet: the same name, else the same package.json name.
// Archived and gone repositories are never suggested. The owner confirms (B7).
export function suggestRepo(appName: string, repos: Pick<StoredRepo, "id" | "name" | "packageName" | "archived" | "goneAt" | "pushedAt">[]): { repoId: string; why: "name" | "package" } | null {
  const live = repos.filter((r) => !r.archived && !r.goneAt).sort((a, b) => (b.pushedAt?.getTime() ?? 0) - (a.pushedAt?.getTime() ?? 0));
  const name = lower(appName);
  const byName = live.find((r) => lower(r.name) === name);
  if (byName) return { repoId: byName.id, why: "name" };
  const byPackage = live.find((r) => r.packageName && bare(r.packageName) === name);
  return byPackage ? { repoId: byPackage.id, why: "package" } : null;
}

export const PACKAGE_READS_PER_RUN = 10;

// Which repositories' package.json to read this run: live, not archived, never read or pushed since the last read;
// newest push first, at most PACKAGE_READS_PER_RUN, so the rest wait for the next run.
export function packageCandidates<R extends Pick<StoredRepo, "archived" | "goneAt" | "pushedAt" | "packageCheckedAt">>(repos: R[]): R[] {
  return repos
    .filter((r) => !r.archived && !r.goneAt && (!r.packageCheckedAt || (r.pushedAt !== null && r.pushedAt > r.packageCheckedAt)))
    .sort((a, b) => (b.pushedAt?.getTime() ?? 0) - (a.pushedAt?.getTime() ?? 0))
    .slice(0, PACKAGE_READS_PER_RUN);
}
