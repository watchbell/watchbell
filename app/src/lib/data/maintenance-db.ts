import "server-only";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db/client";
import { maintenanceWindows, monitors, resources } from "@/db/schema";
import { pathOf } from "@/lib/collector/deploy-sync";
import { MAX_WINDOWS, occurrence, type Window } from "@/lib/maintenance";
import type { Audit } from "./monitors-db";

// U5: maintenance windows are console rows only (nothing at a provider). Not cached: the collector, the alert rules
// and the Uptime page read them in real time.
// 5b final review M6: the MAX_WINDOWS cap counts only windows that can still apply (weekly ones, and one-offs until
// they end), so finished planned work never blocks a new window. The collector, the alert rules and Check now read
// only those (at most MAX_WINDOWS rows); the Uptime page also shows the latest ended ones.

export type WindowRow = Window & { target: string };
export type WindowDone = { ok: true; message: string; audit: Audit } | { ok: false; error: string };

const GONE: WindowDone = { ok: false, error: "That maintenance window no longer exists." };
const TOO_MANY: WindowDone = { ok: false, error: `You can have at most ${MAX_WINDOWS} maintenance windows. Delete one first.` };

const toWindow = (r: typeof maintenanceWindows.$inferSelect): Window => ({
  id: r.id, scope: r.scope, appId: r.resourceId, monitorId: r.monitorId, startsAt: r.startsAt, durationMin: r.durationMin, weekly: r.weekly, note: r.note,
});

// "web/api/health", or "web · backup job" for a heartbeat (its url is "heartbeat:<slug>").
const monitorName = (m: { appName: string | null; url: string | null; kind: string | null; name: string | null }) =>
  `${m.appName ?? "Removed app"}${m.kind === "heartbeat" ? ` · ${m.name ?? ""}` : pathOf(m.url ?? "")}`;

// A window that can still apply, as SQL: weekly ones always, a one-off until its end (the same rule as hasEnded).
const notEnded = sql<boolean>`(${maintenanceWindows.weekly} or ${maintenanceWindows.startsAt} + ${maintenanceWindows.durationMin} * interval '1 minute' > now())`;

// One query: the collector reads this once per run, the alert evaluation and Check now once each.
export async function listRawWindows(): Promise<Window[]> {
  const rows = await db().select().from(maintenanceWindows).where(notEnded)
    .orderBy(asc(maintenanceWindows.startsAt), asc(maintenanceWindows.id)).limit(MAX_WINDOWS);
  return rows.map(toWindow);
}

export async function activeWindows(now: Date): Promise<Window[]> {
  return (await listRawWindows()).filter((w) => occurrence(w, now) !== null);
}

const monApp = alias(resources, "mon_app");

function selectNamed() {
  return db().select({
    w: maintenanceWindows, appName: resources.name, monApp: monApp.name, monAppId: monitors.resourceId, monUrl: monitors.url, monKind: monitors.kind, monName: monitors.name,
  }).from(maintenanceWindows)
    .leftJoin(resources, eq(resources.id, maintenanceWindows.resourceId))
    .leftJoin(monitors, eq(monitors.id, maintenanceWindows.monitorId))
    .leftJoin(monApp, eq(monApp.id, monitors.resourceId));
}
type Named = Awaited<ReturnType<typeof selectNamed>>[number];

const targetOf = (r: Named): string =>
  r.w.scope === "all" ? "All monitors" : r.w.scope === "app" ? r.appName ?? "Removed app" : monitorName({ appName: r.monApp, url: r.monUrl, kind: r.monKind, name: r.monName });

// Uptime → Maintenance windows, with what each applies to: every window that can still apply (at most MAX_WINDOWS),
// then the latest ended ones, shown by start.
export async function listWindows(): Promise<WindowRow[]> {
  const rows = await selectNamed().orderBy(sql`${notEnded} desc`, desc(maintenanceWindows.startsAt), desc(maintenanceWindows.id)).limit(MAX_WINDOWS * 2);
  return rows.map((r) => ({ ...toWindow(r.w), target: targetOf(r) }))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

type Conn = Pick<ReturnType<typeof db>, "select" | "insert" | "update" | "delete" | "execute">;

// What the window applies to, for the audit entry, or an error when the app or monitor no longer exists.
async function target(c: Conn, v: Omit<Window, "id">): Promise<{ name: string; resourceId: string | null } | { error: string }> {
  if (v.scope === "all") return { name: "All monitors", resourceId: null };
  if (v.scope === "app") {
    const [app] = await c.select({ id: resources.id, name: resources.name }).from(resources)
      .where(and(eq(resources.id, v.appId ?? ""), eq(resources.kind, "app"))).limit(1);
    return app ? { name: app.name, resourceId: app.id } : { error: "That application no longer exists." };
  }
  const [m] = await c.select({ appId: monitors.resourceId, appName: resources.name, url: monitors.url, kind: monitors.kind, name: monitors.name }).from(monitors)
    .innerJoin(resources, eq(resources.id, monitors.resourceId)).where(eq(monitors.id, v.monitorId ?? "")).limit(1);
  return m ? { name: monitorName(m), resourceId: m.appId } : { error: "That monitor no longer exists." };
}

const columns = (v: Omit<Window, "id">) => ({
  scope: v.scope, resourceId: v.scope === "app" ? v.appId : null, monitorId: v.scope === "monitor" ? v.monitorId : null,
  startsAt: v.startsAt, durationMin: v.durationMin, weekly: v.weekly, note: v.note,
});

const lockWindows = (c: { execute: Conn["execute"] }) => c.execute(sql`select pg_advisory_xact_lock(hashtext('ops.maintenance_windows'))`);

// How many windows that can still apply there are, other than `exceptId`.
async function liveCount(c: Conn, exceptId?: string): Promise<number> {
  const [count] = await c.select({ n: sql<number>`count(*)::int` }).from(maintenanceWindows)
    .where(exceptId ? and(ne(maintenanceWindows.id, exceptId), notEnded) : notEnded);
  return count?.n ?? 0;
}

// The 20-window cap is check-then-write: one transaction behind a transaction-scoped advisory lock (as for monitors).
export async function createWindow(v: Omit<Window, "id">, by: string): Promise<WindowDone> {
  return db().transaction(async (tx): Promise<WindowDone> => {
    await lockWindows(tx);
    if ((await liveCount(tx)) >= MAX_WINDOWS) return TOO_MANY;
    const t = await target(tx, v);
    if ("error" in t) return { ok: false, error: t.error };
    await tx.insert(maintenanceWindows).values({ ...columns(v), createdBy: by }).returning({ id: maintenanceWindows.id });
    return { ok: true, message: "Maintenance window added.", audit: { message: `Maintenance window added: ${t.name}`, resourceId: t.resourceId } };
  });
}

// Editing an ended window to a later time makes it count again, so the cap is checked here too (the other windows
// that can still apply, under the same lock).
export async function updateWindow(id: string, v: Omit<Window, "id">): Promise<WindowDone> {
  return db().transaction(async (tx): Promise<WindowDone> => {
    await lockWindows(tx);
    if ((await liveCount(tx, id)) >= MAX_WINDOWS) return TOO_MANY;
    const t = await target(tx, v);
    if ("error" in t) return { ok: false, error: t.error };
    const rows = await tx.update(maintenanceWindows).set({ ...columns(v), updatedAt: new Date() }).where(eq(maintenanceWindows.id, id)).returning({ id: maintenanceWindows.id });
    if (!rows.length) return GONE;
    return { ok: true, message: "Maintenance window saved.", audit: { message: `Maintenance window changed: ${t.name}`, resourceId: t.resourceId } };
  });
}

export async function deleteWindow(id: string): Promise<WindowDone> {
  const [row] = await selectNamed().where(eq(maintenanceWindows.id, id)).limit(1);
  if (!row) return GONE;
  const rows = await db().delete(maintenanceWindows).where(eq(maintenanceWindows.id, id)).returning({ id: maintenanceWindows.id });
  if (!rows.length) return GONE;
  const resourceId = row.w.scope === "app" ? row.w.resourceId : row.w.scope === "monitor" ? row.monAppId : null;
  return { ok: true, message: "Maintenance window deleted.", audit: { message: `Maintenance window deleted: ${targetOf(row)}`, resourceId } };
}
