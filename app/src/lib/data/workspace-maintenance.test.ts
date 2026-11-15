import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { accounts, resources, workspaces } from "@/db/schema";

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));

import { createWindow, listRawWindows, listWindows } from "./maintenance-db";

// Watchbell 1.8 (spec §5): a maintenance window for one workspace — saved with its workspace, read with that
// workspace's apps (so the checks and alerts of other clients carry on), named after the workspace.
const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000a2";
const app: Record<string, string> = {};
let client: PGlite;

beforeAll(async () => {
  client = await PGlite.create();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  h.db = db;
  await db.insert(workspaces).values([{ id: A, name: "Kopi Senja", position: 1 }, { id: B, name: "Northwind", position: 2 }]);
  const [acc] = await db.insert(accounts).values({ provider: "vercel", label: "me", credentialCiphertext: "x", credentialIv: "y", credentialKind: "token" }).returning();
  for (const [ws, tag] of [[A, "kopi"], [B, "north"]] as const) {
    app[tag] = (await db.insert(resources).values({ accountId: acc.id, kind: "app", externalId: `prj_${tag}`, name: `${tag}-web`, monitored: true, workspaceId: ws }).returning())[0].id;
  }
}, 60_000);
afterAll(async () => client?.close());

describe("maintenance for one workspace (1.8)", () => {
  it("is saved with its workspace, read with that workspace's apps and named after it", async () => {
    const start = new Date(Date.now() + 3_600_000);
    expect(await createWindow({ scope: "workspace", workspaceId: A, appId: null, monitorId: null, startsAt: start, durationMin: 60, weekly: true, note: null }, "00000000-0000-4000-8000-0000000000c1")).toMatchObject({ ok: true });
    const [w] = await listRawWindows();
    expect(w).toMatchObject({ scope: "workspace", workspaceId: A, appIds: [app.kopi] });
    expect((await listWindows())[0].target).toBe("All of Kopi Senja");
  });

  it("refuses a workspace that doesn't exist", async () => {
    expect(await createWindow({ scope: "workspace", workspaceId: "00000000-0000-4000-8000-0000000000ff", appId: null, monitorId: null, startsAt: new Date(Date.now() + 3_600_000), durationMin: 60, weekly: true, note: null }, "00000000-0000-4000-8000-0000000000c1")).toMatchObject({ ok: false });
  });
});
