import "server-only";
import { and, asc, desc, eq, inArray, isNull, max, ne, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { listFiring } from "./alerts-db";
import { pausedSections } from "./sections-db";
import { reports } from "@/db/report-schema";
import { alerts, appRepos, deployments, githubRepos, monitors, resources, settings, statusPages, workspaces } from "@/db/schema";

// Watchbell 1.8 (docs/superpowers/specs/2026-11-15-watchbell-1-8-workspaces-design.md): workspaces are groups per
// client. Owner-only changes are checked by the actions that call these; nothing here deletes monitoring data.

export type Workspace = { id: string; name: string; position: number };

export const DEFAULT_SETTING = "workspace.default";
const UUID = /^[0-9a-f-]{36}$/i;

const cleanName = (name: string): string | null => {
  const n = name.trim().replace(/\s+/g, " ");
  return n.length >= 1 && n.length <= 60 ? n : null;
};

export async function listWorkspaces(): Promise<Workspace[]> {
  return db().select({ id: workspaces.id, name: workspaces.name, position: workspaces.position }).from(workspaces).orderBy(asc(workspaces.position), asc(workspaces.name));
}

async function nameTaken(name: string, except?: string): Promise<boolean> {
  const rows = await db().select({ id: workspaces.id }).from(workspaces)
    .where(except ? and(sql`lower(${workspaces.name}) = lower(${name})`, ne(workspaces.id, except)) : sql`lower(${workspaces.name}) = lower(${name})`);
  return rows.length > 0;
}

export async function createWorkspace(name: string): Promise<{ id: string } | { error: "name" | "taken" }> {
  const n = cleanName(name);
  if (!n) return { error: "name" };
  if (await nameTaken(n)) return { error: "taken" };
  const [{ next }] = await db().select({ next: sql<number>`coalesce(max(${workspaces.position}) + 1, 0)::int` }).from(workspaces);
  const [row] = await db().insert(workspaces).values({ name: n, position: next }).returning({ id: workspaces.id });
  return { id: row.id };
}

export async function renameWorkspace(id: string, name: string): Promise<"ok" | "name" | "taken" | "not-found"> {
  if (!UUID.test(id)) return "not-found";
  const n = cleanName(name);
  if (!n) return "name";
  if (await nameTaken(n, id)) return "taken";
  const rows = await db().update(workspaces).set({ name: n, updatedAt: new Date() }).where(eq(workspaces.id, id)).returning({ id: workspaces.id });
  return rows.length ? "ok" : "not-found";
}

// The ids in their new order; unknown ids are ignored, missing ones keep their place after the given ones.
export async function reorderWorkspaces(ids: string[]): Promise<void> {
  const all = await listWorkspaces();
  const known = ids.filter((id) => all.some((w) => w.id === id));
  const order = [...known, ...all.map((w) => w.id).filter((id) => !known.includes(id))];
  await db().transaction(async (tx) => {
    for (const [i, id] of order.entries()) await tx.update(workspaces).set({ position: i }).where(eq(workspaces.id, id));
  });
}

// The setting, or the first workspace when it is missing or names one that is gone.
export async function defaultWorkspaceId(): Promise<string> {
  const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, DEFAULT_SETTING)).limit(1);
  const all = await listWorkspaces();
  const wanted = typeof row?.value === "string" ? row.value : null;
  const found = all.find((w) => w.id === wanted) ?? all[0];
  if (!found) throw new Error("no workspace");
  return found.id;
}

export async function setDefaultWorkspace(id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const [w] = await db().select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, id)).limit(1);
  if (!w) return false;
  await db().insert(settings).values({ key: DEFAULT_SETTING, value: id }).onConflictDoUpdate({ target: settings.key, set: { value: id, updatedAt: new Date() } });
  return true;
}

// Everything in the workspace moves to the default one (children with their parents, so all resource rows); its
// status page goes with it (settings, not monitoring data). The default and the last workspace can't be deleted.
export async function deleteWorkspace(id: string): Promise<{ moved: number; statusPageRemoved: boolean } | { error: "default" | "last" | "not-found" }> {
  if (!UUID.test(id)) return { error: "not-found" };
  const all = await listWorkspaces();
  if (!all.some((w) => w.id === id)) return { error: "not-found" };
  const target = await defaultWorkspaceId();
  if (target === id) return { error: "default" };
  if (all.length <= 1) return { error: "last" };
  return db().transaction(async (tx) => {
    // `moved` counts every row that changed workspace: resources (children too), reports and repos.
    const res = await tx.update(resources).set({ workspaceId: target }).where(eq(resources.workspaceId, id)).returning({ id: resources.id });
    const reps = await tx.update(reports).set({ workspaceId: target }).where(eq(reports.workspaceId, id)).returning({ id: reports.id });
    const repos = await tx.update(githubRepos).set({ workspaceId: target }).where(eq(githubRepos.workspaceId, id)).returning({ id: githubRepos.id });
    const pages = await tx.delete(statusPages).where(eq(statusPages.workspaceId, id)).returning({ id: statusPages.id });
    await tx.delete(workspaces).where(eq(workspaces.id, id));
    return { moved: res.length + reps.length + repos.length, statusPageRemoved: pages.length > 0 };
  });
}

export async function workspaceExists(id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  return (await db().select({ id: workspaces.id }).from(workspaces).where(inArray(workspaces.id, [id])).limit(1)).length > 0;
}

export type WorkspaceSummary = {
  id: string; name: string; worst: "down" | "warn" | "ok"; apps: number; monitorsDown: number; openAlerts: number; lastDeployAt: Date | null;
};

// All workspaces (spec §5): each workspace's worst state and counts, plus the open alerts that belong to no resource
// (the install's own: collector, backups, OS updates), counted once.
// Final review (1.8, I2): counted as the pages count — watched apps, monitors that are down and not paused, and the
// open alerts the Alerts page shows (paused sections left out), each filed under its workspace like alertWorkspaceIds.
export async function workspaceSummaries(_now: Date): Promise<{ workspaces: WorkspaceSummary[]; install: { openAlerts: number } }> {
  const watched = and(eq(resources.kind, "app"), eq(resources.monitored, true), isNull(resources.goneAt));
  const [list, apps, down, firing, deploys] = await Promise.all([
    listWorkspaces(),
    db().select({ ws: resources.workspaceId, n: sql<number>`count(*)::int` }).from(resources).where(watched).groupBy(resources.workspaceId),
    db().select({ ws: resources.workspaceId, n: sql<number>`count(*)::int` }).from(monitors).innerJoin(resources, eq(resources.id, monitors.resourceId))
      .where(and(watched, eq(monitors.state, "err"), eq(monitors.paused, false), eq(monitors.ownerPaused, false))).groupBy(resources.workspaceId),
    pausedSections().then((p) => listFiring(p)),
    db().select({ ws: resources.workspaceId, at: max(deployments.createdAtProvider) }).from(deployments).innerJoin(resources, eq(resources.id, deployments.resourceId)).groupBy(resources.workspaceId),
  ]);
  const wsOf = await alertWorkspaceIds(firing);
  const of = <T extends { ws: string }>(rows: T[], ws: string) => rows.find((r) => r.ws === ws);
  return {
    workspaces: list.map((w) => {
      const monitorsDown = of(down, w.id)?.n ?? 0;
      const mine = firing.filter((a) => wsOf.get(a.id) === w.id);
      const openAlerts = mine.length;
      const worst = monitorsDown > 0 || mine.some((a) => a.severity === "critical") ? "down" : openAlerts > 0 ? "warn" : "ok";
      return { id: w.id, name: w.name, worst, apps: of(apps, w.id)?.n ?? 0, monitorsDown, openAlerts, lastDeployAt: of(deploys, w.id)?.at ?? null };
    }),
    install: { openAlerts: firing.filter((a) => !wsOf.has(a.id)).length },
  };
}

// Linking a repo to an app puts the repo in the app's workspace, unless an app in another workspace links it too (a
// monorepo stays where it is). True when the repo moved.
export async function repoFollowsApp(repoId: string, appId: string): Promise<boolean> {
  const [app] = await db().select({ ws: resources.workspaceId }).from(resources).where(eq(resources.id, appId)).limit(1);
  if (!app) return false;
  const linked = await db().select({ ws: resources.workspaceId }).from(appRepos).innerJoin(resources, eq(resources.id, appRepos.appId)).where(eq(appRepos.repoId, repoId));
  if (linked.some((l) => l.ws !== app.ws)) return false;
  const moved = await db().update(githubRepos).set({ workspaceId: app.ws }).where(and(eq(githubRepos.id, repoId), ne(githubRepos.workspaceId, app.ws))).returning({ id: githubRepos.id });
  return moved.length > 0;
}

// Spec §5 "New things": top-level apps, databases and domains first seen in the last 14 days, still in the default
// workspace and never moved or dismissed (sorted_at). Nothing to sort while there is only one workspace.
const UNSORTED_DAYS = 14;
const unsortedWhere = async (now: Date) => and(
  eq(resources.workspaceId, await defaultWorkspaceId()), isNull(resources.parentId), isNull(resources.sortedAt), isNull(resources.goneAt),
  eq(resources.monitored, true), sql`${resources.firstSeenAt} >= ${new Date(now.getTime() - UNSORTED_DAYS * 86_400_000)}`,
);

export async function unsortedCount(now: Date): Promise<number> {
  if ((await listWorkspaces()).length < 2) return 0;
  const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(resources).where(await unsortedWhere(now));
  return row?.n ?? 0;
}

export async function unsortedResources(now: Date): Promise<{ id: string; name: string; kind: string; firstSeenAt: Date }[]> {
  return db().select({ id: resources.id, name: resources.name, kind: resources.kind, firstSeenAt: resources.firstSeenAt }).from(resources)
    .where(await unsortedWhere(now)).orderBy(desc(resources.firstSeenAt)).limit(200);
}

// "Leave them where they are": the note forgets these things (moving them does the same, Task 7).
export async function dismissUnsorted(ids: string[]): Promise<number> {
  const clean = ids.filter((id) => UUID.test(id));
  if (!clean.length) return 0;
  return (await db().update(resources).set({ sortedAt: new Date() }).where(and(inArray(resources.id, clean), isNull(resources.sortedAt))).returning({ id: resources.id })).length;
}

// Which workspace each alert belongs to: its resource's; ReportSendFailed (subject = the report id) its report's. The
// install's own alerts (collector, backups, this machine) are left out of the map.
export async function alertWorkspaceIds(rows: { id: string; resourceId: string | null; ruleKey: string; subject: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const resIds = [...new Set(rows.map((r) => r.resourceId).filter((x): x is string => !!x))];
  const reportIds = [...new Set(rows.filter((r) => !r.resourceId && r.ruleKey === "ReportSendFailed" && UUID.test(r.subject)).map((r) => r.subject))];
  const [res, reps] = await Promise.all([
    resIds.length ? db().select({ id: resources.id, ws: resources.workspaceId }).from(resources).where(inArray(resources.id, resIds)) : [],
    reportIds.length ? db().select({ id: reports.id, ws: reports.workspaceId }).from(reports).where(inArray(reports.id, reportIds)) : [],
  ]);
  const resWs = new Map(res.map((r) => [r.id, r.ws]));
  const repWs = new Map(reps.map((r) => [r.id, r.ws]));
  for (const r of rows) {
    const ws = r.resourceId ? resWs.get(r.resourceId) : r.ruleKey === "ReportSendFailed" ? repWs.get(r.subject) : undefined;
    if (ws) out.set(r.id, ws);
  }
  return out;
}

// For notifications: each alert's workspace name (install alerts have none) and how many workspaces exist, so the text
// names the workspace only when there are several.
export async function alertWorkspaceNames(rows: { id: string; resourceId: string | null; ruleKey: string; subject: string }[]): Promise<{ count: number; nameOf: Map<string, string> }> {
  const list = await listWorkspaces();
  if (list.length < 2) return { count: list.length, nameOf: new Map() };
  const ids = await alertWorkspaceIds(rows);
  const name = new Map(list.map((w) => [w.id, w.name]));
  return { count: list.length, nameOf: new Map([...ids].flatMap(([alertId, ws]) => (name.has(ws) ? [[alertId, name.get(ws) as string]] : []))) };
}

// Spec §5 Moving: the given resources (a child id stands for its top-level resource) move with their children, all
// their history (which follows by resource) and their linked repos (unless an app in another workspace links the same
// repo). Marks them sorted. One transaction.
export async function moveResources(ids: string[], to: string): Promise<{ moved: number; children: number; repos: number }> {
  const clean = [...new Set(ids.filter((id) => UUID.test(id)))];
  if (!clean.length || !(await workspaceExists(to))) return { moved: 0, children: 0, repos: 0 };
  const given = await db().select({ id: resources.id, parentId: resources.parentId }).from(resources).where(inArray(resources.id, clean));
  const tops = [...new Set(given.map((r) => r.parentId ?? r.id))];
  if (!tops.length) return { moved: 0, children: 0, repos: 0 };
  return db().transaction(async (tx) => {
    const now = new Date();
    const moved = await tx.update(resources).set({ workspaceId: to, sortedAt: now }).where(inArray(resources.id, tops)).returning({ id: resources.id });
    const kids = await tx.update(resources).set({ workspaceId: to }).where(inArray(resources.parentId, tops)).returning({ id: resources.id });
    // Repos linked to a moved app follow when every app linking them is now in `to`.
    const links = await tx.select({ repoId: appRepos.repoId }).from(appRepos).where(inArray(appRepos.appId, tops));
    let repos = 0;
    for (const repoId of [...new Set(links.map((l) => l.repoId))]) {
      const users = await tx.select({ ws: resources.workspaceId }).from(appRepos).innerJoin(resources, eq(resources.id, appRepos.appId)).where(eq(appRepos.repoId, repoId));
      if (users.some((u) => u.ws !== to)) continue;
      repos += (await tx.update(githubRepos).set({ workspaceId: to }).where(and(eq(githubRepos.id, repoId), ne(githubRepos.workspaceId, to))).returning({ id: githubRepos.id })).length;
    }
    return { moved: moved.length, children: kids.length, repos };
  });
}

export async function moveRepos(ids: string[], to: string): Promise<number> {
  const clean = [...new Set(ids.filter((id) => UUID.test(id)))];
  if (!clean.length || !(await workspaceExists(to))) return 0;
  return (await db().update(githubRepos).set({ workspaceId: to }).where(inArray(githubRepos.id, clean)).returning({ id: githubRepos.id })).length;
}
