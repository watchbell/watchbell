import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { resources, snapshots } from "@/db/schema";
import { neonData, readData } from "@/lib/databases/snapshot-data";
import { isUuid } from "@/lib/ids";

// Stage 6 Wake (plan Task 3): which Neon project a watched row belongs to, and this period's CU-hours from its last
// snapshot. A watched branch resolves to its parent project (the credential and the API path are the project's), and
// keeps its own branch id so the action can check that the compute belongs to that branch.
export type WakeScope = { projectResourceId: string; branchExternalId: string | null; computeSeconds: number | null; periodEnd: string | null };

export async function wakeScope(resourceId: string): Promise<WakeScope | null> {
  if (!isUuid(resourceId)) return null;
  const [row] = await db().select({ id: resources.id, kind: resources.kind, externalId: resources.externalId, parentId: resources.parentId })
    .from(resources)
    .where(and(eq(resources.id, resourceId), inArray(resources.kind, ["neon_project", "neon_branch"]), isNull(resources.goneAt)))
    .limit(1);
  if (!row) return null;
  const projectResourceId = row.kind === "neon_branch" ? row.parentId : row.id;
  if (!projectResourceId) return null;
  const [snap] = await db().select({ data: snapshots.data }).from(snapshots).where(eq(snapshots.resourceId, projectResourceId)).limit(1);
  const d = readData(neonData, snap?.data);
  return {
    projectResourceId,
    branchExternalId: row.kind === "neon_branch" ? row.externalId : null,
    computeSeconds: d.computeSeconds ?? null,
    periodEnd: d.periodEnd ?? null,
  };
}
