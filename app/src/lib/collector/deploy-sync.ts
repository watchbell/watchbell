// Pure helpers for the Vercel task: which deployment is current / previous, and which rows really changed.

export type ReadyProduction = { id: string; createdAt: Date };

// `candidates` are every READY production deployment of one app that we know of (this poll plus what is stored),
// `projectCurrentId` is what Vercel says is serving production (null unless its latest production build is READY).
// Current is Vercel's answer, else the newest one we know. Previous is the next older READY production deployment,
// which is what a Hobby rollback targets. If the current one is not among the candidates we can't place it, so
// there is no previous.
export function pickFlags(candidates: ReadyProduction[], projectCurrentId: string | null): { currentId: string | null; previousId: string | null } {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const sorted = [...byId.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const currentId = projectCurrentId ?? sorted[0]?.id ?? null;
  const idx = sorted.findIndex((c) => c.id === currentId);
  return { currentId, previousId: idx >= 0 ? sorted[idx + 1]?.id ?? null : null };
}

export type DeploymentFields = {
  state: string; target: string | null; branch: string | null; commitSha: string | null; commitMessage: string | null;
  source: string | null; url: string | null; buildingAt: Date | null; readyAt: Date | null;
};

const time = (d: Date | null) => (d ? d.getTime() : null);

export function deploymentChanged(stored: DeploymentFields | undefined, next: DeploymentFields): boolean {
  if (!stored) return true;
  return stored.state !== next.state || stored.target !== next.target || stored.branch !== next.branch || stored.commitSha !== next.commitSha
    || stored.commitMessage !== next.commitMessage || stored.source !== next.source || stored.url !== next.url
    || time(stored.buildingAt) !== time(next.buildingAt) || time(stored.readyAt) !== time(next.readyAt);
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "/";
  }
}

// The poll only covers the last 7 days, so a production deployment that has been live longer (shortly: 85 days) is
// never in it. Vercel still names it as the project's current one, so each watched app whose current deployment we
// don't have yet is fetched by id. `known` is the READY production deployments of those apps already stored (this poll
// included). Once stored it is not asked for again: at most one extra row per app, and one call only the first time.
// `skip` holds ids that failed recently (see missesAfter), so a deployment Vercel can't hand over isn't retried every minute.
export function currentToFetch(
  apps: { id: string; externalId: string }[],
  currentByProject: Map<string, string | null>,
  known: { resourceId: string; id: string }[],
  skip: ReadonlySet<string> = new Set(),
): { appId: string; deploymentId: string }[] {
  const have = new Set(known.map((k) => `${k.resourceId}/${k.id}`));
  return apps.flatMap((a) => {
    const deploymentId = currentByProject.get(a.externalId);
    return deploymentId && !skip.has(deploymentId) && !have.has(`${a.id}/${deploymentId}`) ? [{ appId: a.id, deploymentId }] : [];
  });
}

// A current deployment that can't be fetched (deleted at Vercel, a 403, a row that isn't READY production) is left alone
// for about 6 hours. The settings row `vercel.currentMiss` is { [deploymentId]: retry-after ISO time }.
export const MISS_BACKOFF_MS = 6 * 3_600_000;

function liveMisses(value: unknown, now: Date): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string" && new Date(e[1]).getTime() > now.getTime()));
}

export const skippedIds = (value: unknown, now: Date): Set<string> => new Set(Object.keys(liveMisses(value, now)));

// The map to store after `ids` just failed: the still-waiting entries, expired ones dropped, plus the new ones.
export function missesAfter(value: unknown, ids: string[], now: Date): Record<string, string> {
  const retryAt = new Date(now.getTime() + MISS_BACKOFF_MS).toISOString();
  return { ...liveMisses(value, now), ...Object.fromEntries(ids.map((id) => [id, retryAt])) };
}
