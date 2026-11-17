import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { accounts, monitors, resources, statusPages, workspaces } from "@/db/schema";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));

import { isPublishedSlug, saveStatusPage, statusPageSettings } from "./public-status-db";

// Watchbell 1.8 (spec §5): one status page per workspace, each with its own address and the workspace's monitors.
const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000a2";
const mon: Record<string, string> = {};
let client: PGlite;

beforeAll(async () => {
  client = await PGlite.create();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  h.db = db;
  await db.insert(workspaces).values([{ id: A, name: "Kopi Senja", position: 1 }, { id: B, name: "Northwind", position: 2 }]);
  const [acc] = await db.insert(accounts).values({ provider: "vercel", label: "me", credentialCiphertext: "x", credentialIv: "y", credentialKind: "token" }).returning();
  for (const [ws, tag] of [[A, "kopi"], [B, "north"]] as const) {
    const [app] = await db.insert(resources).values({ accountId: acc.id, kind: "app", externalId: `prj_${tag}`, name: `${tag}-web`, monitored: true, workspaceId: ws }).returning();
    mon[tag] = (await db.insert(monitors).values({ resourceId: app.id, url: `https://${tag}.example/` }).returning())[0].id;
  }
}, 60_000);
afterAll(async () => client?.close());

const page = (slug: string, monitorId: string) => ({ slug, title: slug, announcement: null, published: true, monitors: [{ monitorId, displayName: "Shop", position: 0 }] });

describe("status page per workspace (1.8)", () => {
  it("each workspace saves its own page with its own address", async () => {
    expect(await saveStatusPage(page("kopi", mon.kopi), A)).toMatchObject({ ok: true });
    expect(await saveStatusPage(page("north", mon.north), B)).toMatchObject({ ok: true });
    expect((await statusPageSettings(A)).page?.slug).toBe("kopi");
    expect((await statusPageSettings(B)).page?.slug).toBe("north");
  });

  it("lists the workspace's monitors, and marks one from elsewhere already on the page", async () => {
    const a = await statusPageSettings(A);
    expect(a.monitors.map((m) => m.appName)).toEqual(["kopi-web"]);
    await saveStatusPage(page("kopi", mon.north), A);
    const again = await statusPageSettings(A);
    expect(again.monitors.find((m) => m.id === mon.north)).toMatchObject({ shown: true, elsewhere: true });
  });

  it("refuses an address another workspace's page uses", async () => {
    expect(await saveStatusPage(page("north", mon.kopi), A)).toEqual({ ok: false, error: "Another workspace's status page uses that address. Pick another one." });
  });
});

// 1.8.1 (public routes audit): a made-up slug is "not found" without reading the page; a page just saved (or
// unpublished) is seen at once on the instance that saved it.
describe("published slugs", () => {
  it("knows published slugs, refuses others, and follows a save", async () => {
    await saveStatusPage(page("kopi", mon.kopi), A);
    expect(await isPublishedSlug("kopi")).toBe(true);
    expect(await isPublishedSlug("made-up")).toBe(false);
    await saveStatusPage({ ...page("kopi", mon.kopi), published: false }, A);
    expect(await isPublishedSlug("kopi")).toBe(false);
    await saveStatusPage(page("kopi-2", mon.kopi), A);
    expect(await isPublishedSlug("kopi-2")).toBe(true);
  });

  // 1.8.3 (1.8.1 deferred minor): a page published on another server instance was "not found" here for up to the
  // memo's minute. A miss now reads the list again, at most once per 10 s, so a flood of made-up slugs still costs
  // one read per 10 s and a new page shows within seconds.
  it("sees a page another server published within 10 s, re-reading at most once per 10 s on misses", async () => {
    await saveStatusPage({ ...page("kopi", mon.kopi), published: false }, A);
    const t = Date.now() + 3_600_000;
    expect(await isPublishedSlug("kopi", t)).toBe(false);
    await (h.db as ReturnType<typeof drizzle>).update(statusPages).set({ published: true }).where(eq(statusPages.slug, "kopi"));
    expect(await isPublishedSlug("kopi", t + 5_000)).toBe(false);
    expect(await isPublishedSlug("kopi", t + 11_000)).toBe(true);
  });
});
