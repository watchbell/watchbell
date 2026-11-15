import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { accounts, checks, deployments, events, githubRepos, monitors, resources, workspaces } from "@/db/schema";
import { EMPTY_BOOK } from "@/lib/view/display-name";

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));
// Some readers ask for the site address (links); any value will do here.
vi.mock("@/lib/env", async (orig) => ({ ...(await orig<typeof import("@/lib/env")>()), serverEnv: () => new Proxy({}, { get: () => "https://ops.example.com" }) }));

import { databaseOptions, listDatabases } from "./databases-db";
import { ongoingBuilds } from "./deployments-db";
import { listEvents } from "./events-db";
import { health } from "./metrics-db";
import { paletteSource } from "./palette-db";
import { listRepoItems } from "./repos-db";
import { topologyColumns } from "./topology-db";
import { dismissUnsorted, unsortedCount, unsortedResources } from "./workspace-db";

// Watchbell 1.8 (spec §5): Overview, Topology, Events, the database pages, Repositories and the palette follow the
// chosen workspace (null = all). Two clients with an app, a monitor and its checks, a build, an event, a Supabase
// project and a repo each; plus one install event (no resource).
const NOW = new Date("2026-11-15T03:00:00Z");
const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000a2";
const P = "00000000-0000-4000-8000-00000000f001";
let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  client = await PGlite.create();
  db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  h.db = db;
  await db.insert(workspaces).values([{ id: A, name: "Kopi Senja", position: 1 }, { id: B, name: "Northwind", position: 2 }]);
  const [acc] = await db.insert(accounts).values({ provider: "vercel", label: "me", credentialCiphertext: "x", credentialIv: "y", credentialKind: "token" }).returning();
  const [supa] = await db.insert(accounts).values({ provider: "supabase", label: "sb", credentialCiphertext: "x", credentialIv: "y", credentialKind: "token" }).returning();
  const [gh] = await db.insert(accounts).values({ provider: "github", label: "gh", credentialCiphertext: "x", credentialIv: "y", credentialKind: "token" }).returning();
  for (const [ws, tag, fails] of [[A, "kopi", 1], [B, "north", 0]] as const) {
    const [app] = await db.insert(resources).values({ accountId: acc.id, kind: "app", externalId: `prj_${tag}`, name: `${tag}-web`, monitored: true, workspaceId: ws }).returning();
    const [m] = await db.insert(monitors).values({ resourceId: app.id, url: `https://${tag}.example/` }).returning();
    await db.insert(checks).values(Array.from({ length: 4 }, (_, i) => ({ monitorId: m.id, at: new Date(NOW.getTime() - (i + 1) * 60_000), ok: i >= fails })));
    await db.insert(deployments).values({ resourceId: app.id, externalId: `dpl_${tag}`, state: "building", createdAtProvider: new Date(NOW.getTime() - 60_000) });
    await db.insert(events).values({ type: "deployment", kind: "ok", message: `${tag} deployed`, resourceId: app.id, at: new Date(NOW.getTime() - 120_000) });
    await db.insert(resources).values({ accountId: supa.id, kind: "supabase_project", externalId: `ref_${tag}`, name: `${tag}-db`, monitored: true, workspaceId: ws });
    await db.insert(githubRepos).values({ accountId: gh.id, externalId: `r_${tag}`, owner: "me", name: tag, fullName: `me/${tag}`, workspaceId: ws });
  }
  await db.insert(events).values({ type: "system", kind: "warn", message: "collector slow", at: new Date(NOW.getTime() - 30_000) });
}, 60_000);
afterAll(async () => client?.close());

describe("Home and database data follow the workspace (1.8)", () => {
  it("Overview's health counts only the workspace's checks (Review Focus 5: numbers match the lists)", async () => {
    expect((await health(NOW, A)).uptime).toBe(75);
    expect((await health(NOW, B)).uptime).toBe(100);
    expect((await health(NOW, null)).uptime).toBe(87.5);
  });

  it("builds, events (install events in every workspace) and the palette", async () => {
    expect((await ongoingBuilds(NOW, A)).map((d) => d.appName)).toEqual(["kopi-web"]);
    const ev = (await listEvents(50, { ws: B })).map((e) => e.message);
    expect(ev).toContain("north deployed");
    expect(ev).toContain("collector slow");
    expect(ev).not.toContain("kopi deployed");
    expect((await paletteSource(A)).apps.map((a) => a.name)).toEqual(["kopi-web"]);
  });

  it("databases, the SQL picker, topology and repositories", async () => {
    expect((await listDatabases("supabase_project", A)).map((d) => d.name)).toEqual(["kopi-db"]);
    expect((await listDatabases("supabase_project", null)).length).toBe(2);
    expect((await databaseOptions(B)).map((d) => d.name)).toEqual(["north-db"]);
    const [, appsCol] = await topologyColumns(NOW, EMPTY_BOOK, A);
    expect(appsCol.map((n) => n.name)).toEqual(["kopi-web"]);
    expect((await listRepoItems(B)).items.map((r) => r.fullName)).toEqual(["me/north"]);
  });
});

// Spec §5: new top-level things in the default workspace, first seen in the last 14 days and never moved or dismissed,
// are "not sorted yet" — only once there is more than one workspace.
describe("not sorted yet", () => {
  it("counts new things in the default workspace, and forgets a dismissed one", async () => {
    const [acc] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.provider, "vercel"));
    const fresh = await db.insert(resources).values([1, 2, 3].map((i) => ({ accountId: acc.id, kind: "app" as const, externalId: `new_${i}`, name: `new-${i}`, monitored: true, workspaceId: P, firstSeenAt: new Date(NOW.getTime() - i * 86_400_000) }))).returning();
    await db.insert(resources).values({ accountId: acc.id, kind: "app", externalId: "old", name: "old", monitored: true, workspaceId: P, firstSeenAt: new Date(NOW.getTime() - 30 * 86_400_000) });
    expect(await unsortedCount(NOW)).toBe(3);
    expect((await unsortedResources(NOW)).map((r) => r.name)).toEqual(["new-1", "new-2", "new-3"]);
    await dismissUnsorted([fresh[0].id]);
    expect(await unsortedCount(NOW)).toBe(2);
  });
});
