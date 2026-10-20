import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, links, resources, snapshots } from "@/db/schema";
import { dbOptionFrom } from "@/lib/databases/option";
import { readData, supabaseData } from "@/lib/databases/snapshot-data";
import { DB_KINDS, DB_PROVIDER_NAME, type DbKind, type DbOption, dbProvider } from "@/lib/links";
import type { State } from "@/lib/status";
import type { SlotInput } from "@/lib/view/databases";
import { PAGE_ROWS } from "@/lib/view/windows";
import { recordAction } from "./audit-db";

export type DbRow = {
  id: string; name: string; externalId: string; kind: DbKind; account: string; state: State;
  stateSince: Date | null; collectedAt: Date | null; data: unknown; usedBy: { id: string; name: string }[];
};

// Watched databases of one kind with their snapshot, account label and the apps linked to them. Bounded (R8).
export async function listDatabases(kind: DbKind): Promise<DbRow[]> {
  const rows = await db().select({ r: resources, s: snapshots, account: accounts.label }).from(resources)
    .innerJoin(accounts, eq(accounts.id, resources.accountId))
    .leftJoin(snapshots, eq(snapshots.resourceId, resources.id))
    .where(and(eq(resources.kind, kind), eq(resources.monitored, true), isNull(resources.goneAt)))
    .orderBy(resources.name).limit(PAGE_ROWS.databases);
  if (!rows.length) return [];
  const users = await db().select({ dbId: links.toResourceId, id: resources.id, name: resources.name }).from(links)
    .innerJoin(resources, eq(resources.id, links.fromResourceId))
    .where(and(eq(links.kind, "uses_db"), inArray(links.toResourceId, rows.map((x) => x.r.id))))
    .orderBy(resources.name).limit(PAGE_ROWS.apps);
  return rows.map(({ r, s, account }) => ({
    id: r.id, name: r.name, externalId: r.externalId, kind, account,
    state: s?.state ?? "unknown", stateSince: s?.stateSince ?? null, collectedAt: s?.collectedAt ?? null, data: s?.data ?? {},
    usedBy: users.filter((u) => u.dbId === r.id).map(({ id, name }) => ({ id, name })),
  }));
}

// Free slots count every Supabase project the token can see, watched or not (D3). Watched ones use the live status;
// the rest the status from the last Sync (resources.meta). An unwatched project borrows its org's plan from a watched one.
export async function supabaseSlotInputs(): Promise<SlotInput[]> {
  const rows = await db().select({ r: resources, s: snapshots, account: accounts.label }).from(resources)
    .innerJoin(accounts, eq(accounts.id, resources.accountId))
    .leftJoin(snapshots, eq(snapshots.resourceId, resources.id))
    .where(and(eq(resources.kind, "supabase_project"), isNull(resources.goneAt)))
    .limit(PAGE_ROWS.databases);
  const plan = new Map<string, boolean | null>();
  for (const { s } of rows) {
    const d = readData(supabaseData, s?.data);
    if (d.orgSlug && d.freeOrg !== undefined) plan.set(d.orgSlug, d.freeOrg);
  }
  return rows.map(({ r, s, account }) => {
    const d = readData(supabaseData, s?.data);
    const org = d.orgSlug ?? (typeof r.meta.orgSlug === "string" ? r.meta.orgSlug : null);
    return {
      id: r.id, account, name: r.name,
      status: d.status ?? (typeof r.meta.status === "string" ? r.meta.status : "UNKNOWN"),
      freeOrg: d.freeOrg ?? (org ? plan.get(org) ?? null : null),
    };
  });
}

export type LinkedDb = { id: string; externalId: string; name: string; kind: DbKind; account: string; state: State };

// Edit link dialog: every watched database, any provider.
export async function databaseOptions(): Promise<DbOption[]> {
  const rows = await db().select({ id: resources.id, name: resources.name, kind: resources.kind, externalId: resources.externalId, account: accounts.label, data: snapshots.data }).from(resources)
    .innerJoin(accounts, eq(accounts.id, resources.accountId))
    .leftJoin(snapshots, eq(snapshots.resourceId, resources.id))
    .where(and(inArray(resources.kind, [...DB_KINDS]), eq(resources.monitored, true), isNull(resources.goneAt)))
    .orderBy(resources.name).limit(PAGE_ROWS.databases);
  return rows.map((r) => dbOptionFrom({ ...r, kind: r.kind as DbKind }));
}

export async function linkedDatabases(appIds: string[]): Promise<Map<string, LinkedDb>> {
  if (!appIds.length) return new Map();
  const rows = await db().select({ app: links.fromResourceId, id: resources.id, externalId: resources.externalId, name: resources.name, kind: resources.kind, account: accounts.label, state: snapshots.state })
    .from(links)
    .innerJoin(resources, eq(resources.id, links.toResourceId))
    .innerJoin(accounts, eq(accounts.id, resources.accountId))
    .leftJoin(snapshots, eq(snapshots.resourceId, resources.id))
    // Only a database the console still watches: an unticked or gone one has a frozen snapshot that would mislead.
    .where(and(eq(links.kind, "uses_db"), inArray(links.fromResourceId, appIds), eq(resources.monitored, true), isNull(resources.goneAt)))
    .limit(PAGE_ROWS.apps);
  return new Map(rows.map((r) => [r.app, { id: r.id, externalId: r.externalId, name: r.name, kind: r.kind as DbKind, account: r.account, state: r.state ?? "unknown" }]));
}

// The owner's (or an operator's) choice on the app page. Console rows only; one database per app (links_one_db_per_app).
// The app's state picks the change up on the next collector run.
export async function saveLink(appId: string, dbId: string | null, actorUserId: string): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const [app] = await db().select({ id: resources.id, name: resources.name }).from(resources)
    .where(and(eq(resources.id, appId), eq(resources.kind, "app"), eq(resources.monitored, true), isNull(resources.goneAt))).limit(1);
  if (!app) return { ok: false, error: "That app is no longer in the console." };
  let target: { id: string; name: string; kind: DbKind } | null = null;
  if (dbId) {
    const [d] = await db().select({ id: resources.id, name: resources.name, kind: resources.kind }).from(resources)
      .where(and(eq(resources.id, dbId), inArray(resources.kind, [...DB_KINDS]), eq(resources.monitored, true), isNull(resources.goneAt))).limit(1);
    if (!d) return { ok: false, error: "That database isn't watched any more. Tick it in Sync first." };
    target = { id: d.id, name: d.name, kind: d.kind as DbKind };
  }
  const message = target ? `${app.name} now uses ${target.name} (${DB_PROVIDER_NAME[dbProvider(target.kind)]}).` : `${app.name} has no database linked.`;
  await db().transaction(async (tx) => {
    await tx.delete(links).where(and(eq(links.fromResourceId, appId), eq(links.kind, "uses_db")));
    if (target) await tx.insert(links).values({ fromResourceId: appId, toResourceId: target.id, kind: "uses_db", source: "manual" });
  });
  try {
    await recordAction({ kind: "ok", message: target ? `Database link: ${app.name} → ${target.name}` : `Database link removed: ${app.name}`, resourceId: appId, actorUserId });
  } catch {
    console.warn("audit event failed");
  }
  return { ok: true, message };
}
