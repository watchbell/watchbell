import "server-only";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, appSecurity, deployments, monitors, resources, snapshots } from "@/db/schema";
import type { SecurityRow } from "@/lib/security/types";
import type { State } from "@/lib/status";
import { storedDomains } from "@/lib/domain-move";
import { type DomainFlag, type DomainLines, appDomainLines } from "@/lib/view/app-domains";
import { appDomain } from "@/lib/view/format";
import { type PageViewsView, pageViewsOf, pageViewsUnavailable } from "@/lib/view/pageviews";
import { type DayCount, lastDays, UPTIME_DAYS, uptimePct } from "@/lib/view/uptime";
import { PAGE_ROWS, WINDOWS } from "@/lib/view/windows";
import { type LinkedDb, linkedDatabases } from "./databases-db";
import { activeFor } from "@/lib/maintenance";
import { type DeployLite, toDeployLite } from "./deployments-db";
import { recordEvents } from "./events-write";
import { listRawWindows } from "./maintenance-db";
import { type AppResponse, appResponse, monitorDays } from "./metrics-db";
import { type MonitorLite, movesOf, toMonitorLite } from "./monitors-db";
import { toSecurityRow } from "./security-db";

export type AppSummary = {
  id: string; name: string; gone: boolean; state: State; stateSince: Date | null; domain: string;
  framework: string | null; productionBranch: string | null; createdAt: Date | null; teamName: string | null;
  // From Sync's project data (the next Sync fills them in): the Vercel team slug and Git repository for "Open in", and
  // the function regions for Details.
  teamSlug: string | null; repo: string | null; repoType: string | null; functionRegions: string[];
  // 1.2.1: every domain the app has on Vercel (primary, attached, former) for the Details card.
  domainLines: DomainLines;
  // Each monitor carries `maintUntil` (U5): the end of the maintenance window it is inside now, else null.
  monitors: (MonitorLite & { maintUntil: Date | null })[]; lastDeploy: DeployLite | null; uptime30: number | null; response: AppResponse;
  days: Map<string, Map<string, DayCount>>;
  // The Next.js security check (ops.app_security), null until the first check.
  security: SecurityRow | null;
  // The database the owner linked to this app (ops.links, uses_db), and whether the collector found it paused (D7).
  database: LinkedDb | null; dbPaused: boolean;
  // Page views of the last 24 h from Vercel Web Analytics (the `pageviews` task), null until the first read.
  pageViews: PageViewsView | null;
  // Why the pageviews task can never read this app (not in a connected Vercel account, no production deployment); null when it can.
  pageViewsNote: string | null;
};

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

// Watched apps (a gone one too, so a vanished project still shows), with everything the app tables need: monitors,
// the latest production deployment, 30-day uptime, 24 h response and the Next.js security row. At most 200 apps and 200 monitors (R8).
export async function listApps(now: Date, onlyId?: string): Promise<AppSummary[]> {
  const apps = await db().select({ r: resources, s: snapshots, sec: appSecurity, accStatus: accounts.status }).from(resources)
    .leftJoin(accounts, eq(accounts.id, resources.accountId))
    .leftJoin(snapshots, eq(snapshots.resourceId, resources.id))
    .leftJoin(appSecurity, eq(appSecurity.resourceId, resources.id))
    .where(and(eq(resources.kind, "app"), eq(resources.monitored, true), onlyId ? eq(resources.id, onlyId) : undefined))
    .orderBy(resources.name).limit(PAGE_ROWS.apps);
  if (!apps.length) return [];
  const ids = apps.map((a) => a.r.id);
  const mons = (await db().select().from(monitors).where(inArray(monitors.resourceId, ids)).orderBy(monitors.createdAt)
    .limit(PAGE_ROWS.monitors)).map(toMonitorLite);
  const latest = await db().selectDistinctOn([deployments.resourceId]).from(deployments)
    .where(and(inArray(deployments.resourceId, ids), eq(deployments.target, "production")))
    .orderBy(deployments.resourceId, desc(deployments.createdAtProvider));
  const days = await monitorDays(mons.map((m) => m.id), now);
  // Watchbell 1.2.1: monitors still on a domain their app no longer has ("Domain changed", Update monitor).
  const appRow = new Map(apps.map((a) => [a.r.id, a.r]));
  const moves = await movesOf(mons.map((m) => ({ id: m.id, kind: m.kind, url: m.url, appId: m.appId, appName: appRow.get(m.appId)?.name ?? "", appMeta: appRow.get(m.appId)?.meta, lastError: m.lastError })));
  // 1.2.1: redirect / verified flags of each app's domain rows (the names themselves are on the app: storedDomains).
  const flags = new Map<string, Record<string, DomainFlag>>();
  for (const d of await db().select({ parentId: resources.parentId, name: resources.name, meta: resources.meta }).from(resources)
    .where(and(eq(resources.kind, "domain"), inArray(resources.parentId, ids), isNull(resources.goneAt)))) {
    if (!d.parentId) continue;
    const m = flags.get(d.parentId) ?? {};
    m[d.name.toLowerCase()] = { redirect: str(d.meta.redirect), verified: d.meta.verified !== false };
    flags.set(d.parentId, m);
  }
  const response = await appResponse(ids, now);
  const dbs = await linkedDatabases(ids);
  // U5 / review I1: one read of the maintenance windows (at most 20 rows), so every page built on listApps (Overview,
  // Applications, the app page, Topology) shows a monitor inside a window as Uptime does.
  const windows = mons.length ? await listRawWindows() : [];
  return apps.map(({ r, s, sec, accStatus }) => {
    const own = mons.filter((m) => m.appId === r.id).map((m) => ({ ...m, maintUntil: activeFor(windows, { monitorId: m.id, appId: m.appId }, now)?.end ?? null, move: moves.get(m.id) ?? null }));
    const created = str(r.meta.createdAt);
    const dep = latest.find((d) => d.resourceId === r.id);
    return {
      id: r.id, name: r.name, gone: r.goneAt !== null, state: s?.state ?? "unknown", stateSince: s?.stateSince ?? null,
      // 1.2.1: the domain production is served on (Sync / the domains task), else the first monitor's host as before.
      domain: storedDomains(r.meta)?.primaryDomain ?? appDomain(r.name, own.map((m) => m.url)),
      domainLines: appDomainLines(r.meta, flags.get(r.id) ?? {}, storedDomains(r.meta)?.primaryDomain ?? appDomain(r.name, own.map((m) => m.url))),
      framework: str(r.meta.framework), productionBranch: str(r.meta.productionBranch),
      createdAt: created ? new Date(created) : null, teamName: str(r.meta.teamName),
      teamSlug: str(r.meta.teamSlug), repo: str(r.meta.repo), repoType: str(r.meta.repoType),
      functionRegions: Array.isArray(r.meta.functionRegions) ? r.meta.functionRegions.filter((x): x is string => typeof x === "string") : [],
      monitors: own, lastDeploy: dep ? toDeployLite(dep) : null,
      uptime30: uptimePct(own.flatMap((m) => lastDays(days.get(m.id), now, UPTIME_DAYS))),
      response: response.get(r.id) ?? { hourly: Array.from({ length: WINDOWS.responseHours }, () => null), p95: null, p50: null },
      days: new Map(own.flatMap((m) => { const d = days.get(m.id); return d ? [[m.id, d] as const] : []; })),
      security: sec ? toSecurityRow(sec) : null,
      database: dbs.get(r.id) ?? null, dbPaused: s?.data.dbPaused === true, pageViews: pageViewsOf(s?.data),
      pageViewsNote: pageViewsUnavailable({ gone: r.goneAt !== null, teamId: str(r.meta.teamId), accountOk: accStatus === "ok", hasProductionDeploy: dep !== undefined }),
    };
  });
}

export async function getApp(id: string, now: Date): Promise<AppSummary | null> {
  return (await listApps(now, id))[0] ?? null;
}

// App page → "Remove from console" (owner): unwatches the app and deletes its console history (monitors with their
// checks and rollups, deployments, the snapshot, the security check, its domain rows). Events stay as the record of what happened, and one more is added
// for the removal itself (spec §12). Nothing changes at Vercel, and ticking the app in Sync later brings it back
// with a fresh default monitor.
export async function removeApp(appId: string, actorUserId: string): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const [app] = await db().select({ id: resources.id, name: resources.name }).from(resources)
    .where(and(eq(resources.id, appId), eq(resources.kind, "app"))).limit(1);
  if (!app) return { ok: false, error: "That app is no longer in the console." };
  await db().transaction(async (tx) => {
    const now = new Date();
    await tx.update(resources).set({ monitored: false, updatedAt: now }).where(eq(resources.id, appId));
    await tx.delete(monitors).where(eq(monitors.resourceId, appId));
    await tx.delete(deployments).where(eq(deployments.resourceId, appId));
    await tx.delete(snapshots).where(eq(snapshots.resourceId, appId));
    await tx.delete(appSecurity).where(eq(appSecurity.resourceId, appId));
    // The app's domain rows (console rows only; their snapshots go with them by cascade).
    await tx.delete(resources).where(and(eq(resources.kind, "domain"), eq(resources.parentId, appId)));
    await recordEvents([{ type: "action", kind: "ok", message: `${app.name} removed from the console`, detail: null, resourceId: appId, actorUserId }], tx);
  });
  return { ok: true, message: `${app.name} is no longer in the console. The Vercel project itself isn't touched.` };
}
