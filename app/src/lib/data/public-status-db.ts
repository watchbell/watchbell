import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { monitors, resources, statusPageMonitors, statusPages } from "@/db/schema";
import { pathOf } from "@/lib/collector/deploy-sync";
import { activeFor, covers, nextOccurrence } from "@/lib/maintenance";
import { badgeKey, MAX_ON_PAGE, type PublicState, publicState, type StatusPageValue } from "@/lib/public-status";
import type { State } from "@/lib/status";
import { clock, dayMonth } from "@/lib/time";
import { pct } from "@/lib/view/format";
import { BAR_DAYS, lastDays, type Tone, uptimeBars, uptimePct } from "@/lib/view/uptime";
import { PAGE_ROWS } from "@/lib/view/windows";
import type { Audit } from "./monitors-db";
import { listRawWindows } from "./maintenance-db";
import { monitorDays } from "./metrics-db";

export type PublicView = {
  title: string; announcement: string | null;
  maintenance: { note: string | null; from: string; to: string; active: boolean }[];
  monitors: { name: string; badge: string; state: PublicState; label: string; uptime: string; bars: { tone: Tone; title: string }[] }[];
};

const SOON_MS = 7 * 86_400_000;

// B1: the public page's only queries. They select named columns (never url, last_error, status codes or the names of
// apps, databases or providers) and the result is words, numbers and colours. The ids and app ids are read to join
// the day counts and maintenance windows; they never leave this module. Unpublished or unknown → null (404).
async function load(slug: string) {
  const [page] = await db().select({ id: statusPages.id, title: statusPages.title, announcement: statusPages.announcement, published: statusPages.published })
    .from(statusPages).where(eq(statusPages.slug, slug)).limit(1);
  if (!page?.published) return null;
  const pageMonitors = async () => db().select({
    displayName: statusPageMonitors.displayName, badgeKey: statusPageMonitors.badgeKey, position: statusPageMonitors.position,
    id: monitors.id, appId: monitors.resourceId, state: monitors.state, paused: monitors.paused, ownerPaused: monitors.ownerPaused, kind: monitors.kind,
    // An app that is no longer watched, or gone from its provider, isn't checked any more: its last state is stale.
    watched: sql<boolean>`(${resources.monitored} and ${resources.goneAt} is null)`,
  }).from(statusPageMonitors)
    .innerJoin(monitors, eq(monitors.id, statusPageMonitors.monitorId))
    .innerJoin(resources, eq(resources.id, monitors.resourceId))
    .where(eq(statusPageMonitors.pageId, page.id)).orderBy(asc(statusPageMonitors.position)).limit(MAX_ON_PAGE);
  // Both are async functions, so their queries start in this order (perf P4: sent together).
  const [rows, windows] = await Promise.all([pageMonitors(), listRawWindows()]);
  return { page, rows, windows };
}

export async function publicView(slug: string, now: Date): Promise<PublicView | null> {
  const l = await load(slug);
  if (!l) return null;
  const days = await monitorDays(l.rows.map((r) => r.id), now);
  const targets = l.rows.map((r) => ({ monitorId: r.id, appId: r.appId }));
  const affecting = l.windows.filter((w) => targets.some((t) => covers(w, t)));
  return {
    title: l.page.title,
    announcement: l.page.announcement,
    maintenance: affecting.flatMap((w) => {
      const o = nextOccurrence(w, now);
      if (!o || o.start.getTime() > now.getTime() + SOON_MS) return [];
      return [{ note: w.note, from: `${dayMonth(o.start)} ${clock(o.start)}`, to: clock(o.end), active: o.start.getTime() <= now.getTime() }];
    }),
    monitors: l.rows.map((r) => {
      // Like the app pages: a heartbeat (a job of the app) that stopped pinging makes the service Degraded, not Down.
      const state: State = r.kind === "heartbeat" && r.state === "err" ? "warn" : r.state;
      const held = activeFor(l.windows, { monitorId: r.id, appId: r.appId }, now) !== null;
      const s = publicState(state, held, r.paused || r.ownerPaused || !r.watched);
      const d = days.get(r.id);
      return {
        name: r.displayName, badge: r.badgeKey, state: s.state, label: s.label,
        uptime: pct(uptimePct(lastDays(d, now, BAR_DAYS))),
        bars: uptimeBars(d, now).map((b) => ({ tone: b.tone, title: b.title })),
      };
    }),
  };
}

// U7: the badge reuses the page's query; at one render per 5 minutes per badge that is cheap.
export async function publicBadge(slug: string, key: string, now: Date): Promise<{ label: string; value: string; tone: PublicState } | null> {
  const v = await publicView(slug, now);
  const m = v?.monitors.find((x) => x.badge === key);
  return m ? { label: "uptime", value: m.uptime === "—" ? m.label.toLowerCase() : m.uptime, tone: m.state } : null;
}

// Uptime page: the monitors a visitor can see (on a published page), for their Public tag.
export async function publicMonitorIds(): Promise<Set<string>> {
  const rows = await db().select({ monitorId: statusPageMonitors.monitorId }).from(statusPageMonitors)
    .innerJoin(statusPages, eq(statusPages.id, statusPageMonitors.pageId)).where(eq(statusPages.published, true)).limit(MAX_ON_PAGE);
  return new Set(rows.map((r) => r.monitorId));
}

// Settings → Status page (owner only). The console's own view: real app names are fine here.
export type StatusPageSettings = {
  page: { slug: string; title: string; announcement: string | null; published: boolean } | null;
  monitors: { id: string; appName: string; path: string; kind: "http" | "heartbeat"; shown: boolean; displayName: string }[];
};

export async function statusPageSettings(): Promise<StatusPageSettings> {
  const [[page], mons] = await Promise.all([
    db().select({ id: statusPages.id, slug: statusPages.slug, title: statusPages.title, announcement: statusPages.announcement, published: statusPages.published })
      .from(statusPages).orderBy(asc(statusPages.createdAt)).limit(1),
    db().select({ id: monitors.id, appName: resources.name, url: monitors.url, kind: monitors.kind, name: monitors.name }).from(monitors)
      .innerJoin(resources, eq(resources.id, monitors.resourceId))
      .where(and(eq(resources.kind, "app"), eq(resources.monitored, true), isNull(resources.goneAt)))
      .orderBy(resources.name, desc(monitors.kind), monitors.url).limit(PAGE_ROWS.monitors),
  ]);
  const onPage = page
    ? await db().select({ monitorId: statusPageMonitors.monitorId, displayName: statusPageMonitors.displayName, position: statusPageMonitors.position })
      .from(statusPageMonitors).where(eq(statusPageMonitors.pageId, page.id)).orderBy(asc(statusPageMonitors.position)).limit(MAX_ON_PAGE)
    : [];
  const shown = new Map(onPage.map((p) => [p.monitorId, p]));
  const rows = mons.map((m) => {
    const hb = m.kind === "heartbeat";
    const p = shown.get(m.id);
    return { id: m.id, appName: m.appName, path: hb ? (m.name ?? "heartbeat") : pathOf(m.url), kind: hb ? "heartbeat" as const : "http" as const, shown: !!p, displayName: p?.displayName ?? "" };
  });
  // The page's monitors first, in their order; then the rest as the Uptime page lists them.
  const pos = (id: string) => shown.get(id)?.position ?? Number.MAX_SAFE_INTEGER;
  rows.sort((a, b) => pos(a.id) - pos(b.id));
  return { page: page ? { slug: page.slug, title: page.title, announcement: page.announcement, published: page.published } : null, monitors: rows };
}

export type SaveDone = { ok: true; message: string; audit: Audit; oldSlug: string | null } | { ok: false; error: string };

const MISSING: SaveDone = { ok: false, error: "A monitor on the list no longer exists. Reload and try again." };

// B5: one page. It and its monitors are replaced in one transaction, under a lock so two saves can't create two pages.
export async function saveStatusPage(v: StatusPageValue): Promise<SaveDone> {
  return db().transaction(async (tx): Promise<SaveDone> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ops.status_pages'))`);
    const [existing] = await tx.select({ id: statusPages.id, slug: statusPages.slug }).from(statusPages).orderBy(asc(statusPages.createdAt)).limit(1);
    const ids = v.monitors.map((m) => m.monitorId);
    if (ids.length) {
      const found = await tx.select({ id: monitors.id }).from(monitors).where(inArray(monitors.id, ids)).limit(MAX_ON_PAGE);
      if (found.length !== new Set(ids).size) return MISSING;
    }
    const fields = { slug: v.slug, title: v.title, announcement: v.announcement, published: v.published };
    let pageId: string;
    if (existing) {
      await tx.update(statusPages).set({ ...fields, updatedAt: new Date() }).where(eq(statusPages.id, existing.id));
      pageId = existing.id;
    } else {
      const [created] = await tx.insert(statusPages).values(fields).returning({ id: statusPages.id });
      pageId = created.id;
    }
    await tx.delete(statusPageMonitors).where(eq(statusPageMonitors.pageId, pageId));
    if (v.monitors.length) {
      await tx.insert(statusPageMonitors).values(v.monitors.map((m) => ({
        pageId, monitorId: m.monitorId, displayName: m.displayName, badgeKey: badgeKey(m.displayName), position: m.position,
      })));
    }
    const n = v.monitors.length;
    return {
      ok: true,
      message: "Status page saved. It updates within a minute.",
      audit: { message: `Status page saved: /s/${v.slug} (${v.published ? "published" : "not published"}, ${n} monitor${n === 1 ? "" : "s"})`, resourceId: null },
      oldSlug: existing && existing.slug !== v.slug ? existing.slug : null,
    };
  });
}
