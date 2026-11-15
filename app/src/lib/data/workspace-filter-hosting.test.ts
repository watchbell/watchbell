import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { accounts, deployments, monitors, resources, storedLogs, workspaces } from "@/db/schema";

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));

import { listApps } from "./apps-db";
import { listDeployments } from "./deployments-db";
import { listStoredLogs } from "./logs-db";
import { appOptions, listMonitors } from "./monitors-db";
import { getZoneView, listDomains, listZoneOptions } from "./network-db";

// Watchbell 1.8 (spec §5): the Hosting pages show the chosen workspace (ws), every workspace with null. Two clients,
// each with an app, a monitor, a deployment, a domain, a zone and a log line.
const NOW = new Date("2026-11-15T03:00:00Z");
const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000a2";
let client: PGlite;

beforeAll(async () => {
  client = await PGlite.create();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  h.db = db;
  await db.insert(workspaces).values([{ id: A, name: "Kopi Senja", position: 1 }, { id: B, name: "Northwind", position: 2 }]);
  const [acc] = await db.insert(accounts).values({ provider: "vercel", label: "me", credentialCiphertext: "x", credentialIv: "y", credentialKind: "token" }).returning();
  const [cf] = await db.insert(accounts).values({ provider: "cloudflare", label: "cf", credentialCiphertext: "x", credentialIv: "y", credentialKind: "token" }).returning();
  for (const [ws, tag] of [[A, "kopi"], [B, "north"]] as const) {
    const [app] = await db.insert(resources).values({ accountId: acc.id, kind: "app", externalId: `prj_${tag}`, name: `${tag}-web`, monitored: true, workspaceId: ws }).returning();
    await db.insert(resources).values({ accountId: acc.id, kind: "domain", externalId: `${tag}.example`, name: `${tag}.example`, parentId: app.id, monitored: true, workspaceId: ws });
    await db.insert(resources).values({ accountId: cf.id, kind: "zone", externalId: `zone_${tag}`, name: `${tag}.example`, monitored: true, workspaceId: ws });
    await db.insert(monitors).values({ resourceId: app.id, url: `https://${tag}.example/` });
    await db.insert(deployments).values({ resourceId: app.id, externalId: `dpl_${tag}`, state: "READY", createdAtProvider: new Date(NOW.getTime() - 3_600_000) });
    await db.insert(storedLogs).values({ resourceId: app.id, deploymentId: `dpl_${tag}`, rowId: `row_${tag}`, at: new Date(NOW.getTime() - 60_000), level: "error", message: `${tag} broke` });
  }
}, 60_000);
afterAll(async () => client?.close());

const names = (rows: { name?: string | null; appName?: string | null; app?: string | null }[]) => rows.map((r) => r.appName ?? r.app ?? r.name).sort();

describe("Hosting data follows the workspace (1.8)", () => {
  it("Applications", async () => {
    expect(names(await listApps(NOW, undefined, A))).toEqual(["kopi-web"]);
    expect(names(await listApps(NOW, undefined, null))).toEqual(["kopi-web", "north-web"]);
    // One app by id (its page) is found whatever the workspace, and says which one it is in.
    const [north] = (await listApps(NOW, undefined, B));
    expect((await listApps(NOW, north.id, A))[0]).toMatchObject({ name: "north-web", workspaceId: B });
  });

  it("Deployments", async () => {
    expect(names(await listDeployments({ ws: B }))).toEqual(["north-web"]);
    expect((await listDeployments({})).length).toBe(2);
  });

  it("Uptime monitors and the app picker", async () => {
    expect(names(await listMonitors(NOW, A))).toEqual(["kopi-web"]);
    expect((await listMonitors(NOW)).length).toBe(2);
    expect(names(await appOptions(B))).toEqual(["north-web"]);
  });

  it("Domains and DNS zones", async () => {
    expect((await listDomains(A)).map((d) => d.name)).toEqual(["kopi.example"]);
    expect((await listDomains(null)).length).toBe(2);
    expect((await listZoneOptions(B)).map((z) => z.name)).toEqual(["north.example"]);
    expect((await getZoneView(null, B))?.name).toBe("north.example");
  });

  it("Logs", async () => {
    expect(names(await listStoredLogs(NOW, { ws: A }))).toEqual(["kopi-web"]);
    expect((await listStoredLogs(NOW, {})).length).toBe(2);
  });
});
