import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { accounts, monitors, resources, workspaces } from "@/db/schema";

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));

import { saveStatusPage, statusPageSettings } from "./public-status-db";

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
