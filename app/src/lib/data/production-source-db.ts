import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { deployments, resources } from "@/db/schema";
import { PRODUCTION_SOURCE_REFRESH_MS, type ProductionSource, productionSourceOf, readProductionSource, sameProductionSource } from "@/lib/deps/branch";

// Where a deployment's branch came from, for the deployments the Vercel task read from Vercel this run (lib/providers/
// vercel.ts toDeployment: branchFrom, gitDirty). The deployments table doesn't keep it.
export type DeploymentOrigin = { branchFrom?: string; gitDirty?: boolean };

// Watchbell 1.2.2 (D15): what each app's current production deployment was really built from, recorded in
// resources.meta.productionSource ({ kind: "git" | "cli", ref?, sha?, at, id }, lib/deps/branch.ts) by the Vercel task
// after it set the current flags. One read of the current rows. An app is written when its source changed, or (review
// I2) when the stored reading is older than PRODUCTION_SOURCE_REFRESH_MS, so `at` says the source was confirmed lately;
// the gates treat a reading older than 30 minutes as "can't confirm". An app without a known current deployment, or whose
// deployment names no source, keeps what it had (and that ages).
// Fix round 3: the kind needs the deployment's meta (a redeploy or promote of a CLI deployment), which only the
// deployments read this run carry (`seen`). A current deployment not read this run keeps the kind stored for the same
// deployment id; one never classified before is classified from its stored row only when Vercel's source is "git" or
// "cli" (fix round 4), else the old reading is kept without its time ("can't confirm"; the merge watcher reads it live).
export async function recordProductionSources(
  apps: readonly { id: string; meta: Record<string, unknown> | null }[], now: Date, seen: ReadonlyMap<string, DeploymentOrigin> = new Map(),
): Promise<number> {
  if (!apps.length) return 0;
  const rows = await db().select({ app: deployments.resourceId, id: deployments.externalId, source: deployments.source, branch: deployments.branch, sha: deployments.commitSha })
    .from(deployments).where(and(inArray(deployments.resourceId, apps.map((a) => a.id)), eq(deployments.isCurrent, true)));
  let written = 0;
  for (const app of apps) {
    const cur = rows.find((r) => r.app === app.id);
    if (!cur) continue;
    const had = readProductionSource(app.meta?.productionSource);
    const origin = seen.get(cur.id);
    const row = { source: cur.source ?? null, branch: cur.branch ?? null, sha: cur.sha ?? null };
    let next: ProductionSource | null;
    if (origin) next = productionSourceOf({ ...row, branchFrom: origin.branchFrom ?? null, gitDirty: origin.gitDirty === true });
    else if (had?.id === cur.id) next = { kind: had.kind, ...(had.ref ? { ref: had.ref } : {}), ...(had.sha ? { sha: had.sha } : {}) };
    // Fix round 4 (re-review r3 minor 2b): without the deployment's meta, only Vercel's own "git" or "cli" is trusted; a
    // redeploy, a promote or an unknown source could be a CLI deployment carried over.
    else next = row.source === "git" || row.source === "cli" ? productionSourceOf(row) : null;
    if (!next) {
      // Minor 2a/2b: the current deployment's source can't be established, and the stored reading is of another deployment
      // (or of none named): it confirms nothing any more. Kept without its time, so the gates read "can't confirm" (not
      // dropped: a value never recorded is the permissive case). Written once.
      if (had?.at && had.id !== cur.id) {
        const rest: ProductionSource = { ...had };
        delete rest.at;
        await db().update(resources).set({ meta: sql`${resources.meta} || ${JSON.stringify({ productionSource: rest })}::jsonb` }).where(eq(resources.id, app.id));
        written++;
      }
      continue;
    }
    next = { ...next, id: cur.id };
    const recent = !!had?.at && now.getTime() - Date.parse(had.at) < PRODUCTION_SOURCE_REFRESH_MS;
    if (sameProductionSource(had, next) && recent) continue;
    const productionSource = { ...next, at: now.toISOString() };
    await db().update(resources).set({ meta: sql`${resources.meta} || ${JSON.stringify({ productionSource })}::jsonb` }).where(eq(resources.id, app.id));
    written++;
  }
  return written;
}
