import "server-only";
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/db/client";
import { deployments, resources } from "@/db/schema";
import { PAGE_ROWS } from "@/lib/view/windows";

// externalId: Vercel's deployment id (dpl_…), what the stage 6 actions act on.
export type DeployLite = {
  id: string; externalId: string; state: string; target: string | null; branch: string | null; commitSha: string | null; commitMessage: string | null;
  url: string | null; createdAt: Date; buildingAt: Date | null; readyAt: Date | null; isCurrent: boolean; isPreviousProduction: boolean;
};

export function toDeployLite(d: typeof deployments.$inferSelect): DeployLite {
  return {
    id: d.id, externalId: d.externalId, state: d.state, target: d.target, branch: d.branch, commitSha: d.commitSha, commitMessage: d.commitMessage, url: d.url,
    createdAt: d.createdAtProvider, buildingAt: d.buildingAt, readyAt: d.readyAt, isCurrent: d.isCurrent, isPreviousProduction: d.isPreviousProduction,
  };
}

export type DeploymentRow = DeployLite & { appId: string; appName: string };

// Deployments page (and the app page's tab): newest first, watched apps only, at most 200 rows (R8).
export async function listDeployments(opts: { appId?: string } = {}): Promise<DeploymentRow[]> {
  const rows = await db().select({ d: deployments, appName: resources.name }).from(deployments)
    .innerJoin(resources, eq(resources.id, deployments.resourceId))
    .where(and(eq(resources.monitored, true), opts.appId ? eq(deployments.resourceId, opts.appId) : undefined))
    .orderBy(desc(deployments.createdAtProvider)).limit(PAGE_ROWS.deployments);
  return rows.map(({ d, appName }) => ({ ...toDeployLite(d), appId: d.resourceId, appName }));
}

// Overview → Activity → Ongoing. A build older than an hour that still says "building" was never updated, as in the
// collector's app state rule, so it isn't shown as ongoing.
export async function ongoingBuilds(now: Date): Promise<DeploymentRow[]> {
  const rows = await db().select({ d: deployments, appName: resources.name }).from(deployments)
    .innerJoin(resources, eq(resources.id, deployments.resourceId))
    .where(and(eq(resources.monitored, true), eq(deployments.state, "building"), gte(deployments.createdAtProvider, new Date(now.getTime() - 3_600_000))))
    .orderBy(desc(deployments.createdAtProvider)).limit(PAGE_ROWS.ongoingBuilds);
  return rows.map(({ d, appName }) => ({ ...toDeployLite(d), appId: d.resourceId, appName }));
}
