import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { monitors, resources } from "@/db/schema";
import { pathOf } from "@/lib/collector/deploy-sync";
import type { PaletteSource } from "@/lib/view/palette";
import { appDomain } from "@/lib/view/format";
import { PAGE_ROWS } from "@/lib/view/windows";

// Command palette (Ctrl K): ids, names and domains of the watched apps, the path of each monitor and the watched domains, nothing else.
// Three small reads (at most 200 each), run once when the palette first opens, never on a page render.
export async function paletteSource(): Promise<PaletteSource> {
  const apps = await db().select({ id: resources.id, name: resources.name }).from(resources)
    .where(and(eq(resources.kind, "app"), eq(resources.monitored, true)))
    .orderBy(resources.name).limit(PAGE_ROWS.apps);
  // Watched domains, the same rows the Domains page lists: not gone, and (when they belong to an app) of a watched app.
  const doms = await db().select({ id: resources.id, name: resources.name, parentId: resources.parentId }).from(resources)
    .where(and(eq(resources.kind, "domain"), eq(resources.monitored, true), isNull(resources.goneAt)))
    .orderBy(resources.name).limit(PAGE_ROWS.domains);
  const watched = new Set(apps.map((a) => a.id));
  const domains = doms.filter((d) => !d.parentId || watched.has(d.parentId)).map((d) => ({ id: d.id, name: d.name }));
  if (!apps.length) return { apps: [], monitors: [], domains };
  const mons = await db().select({ id: monitors.id, appId: monitors.resourceId, url: monitors.url, kind: monitors.kind, name: monitors.name }).from(monitors)
    .where(inArray(monitors.resourceId, apps.map((a) => a.id))).orderBy(monitors.createdAt).limit(PAGE_ROWS.monitors);
  const name = new Map(apps.map((a) => [a.id, a.name]));
  return {
    domains,
    apps: apps.map((a) => ({ ...a, domain: appDomain(a.name, mons.filter((m) => m.appId === a.id).map((m) => m.url)) })),
    // A heartbeat (U3) is shown by its name: "web · backup job".
    monitors: mons.map((m) => ({ id: m.id, appId: m.appId, appName: name.get(m.appId) ?? "", path: m.kind === "heartbeat" ? ` · ${m.name ?? "heartbeat"}` : pathOf(m.url) })),
  };
}
