import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import { reports } from "@/db/report-schema";
import * as schema from "@/db/schema";
import { accounts, alertRules, alerts, appRepos, deployments, githubRepos, monitors, resources, statusPages } from "@/db/schema";

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));

import { createWorkspace, defaultWorkspaceId, deleteWorkspace, listWorkspaces, renameWorkspace, reorderWorkspaces, alertWorkspaceIds, moveRepos, moveResources, repoFollowsApp, setDefaultWorkspace, workspaceSummaries } from "./workspace-db";

type Db = ReturnType<typeof drizzle<typeof schema>>;
const TMP = tmpdir(); // the system temp folder (TEMP / TMPDIR)
let client: PGlite;
let db: Db;
let folder = "";

// Review Focus 1 (1.8): an install upgraded from 1.7 with data. The migrations before workspaces run first, rows go in,
// then the workspace migration runs: every row must land in Personal, which becomes the default.
beforeAll(async () => {
  folder = mkdtempSync(join(TMP, "wb-ws-mig-"));
  const real = selfhostMigrationsFolder();
  cpSync(real, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((e) => !e.tag.startsWith("0013"));
  writeFileSync(journalPath, JSON.stringify(journal));

  client = await PGlite.create();
  db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: folder });
  // Rows as 1.7 wrote them (no workspace column yet), by plain SQL.
  await db.execute(sql`insert into ops.accounts (id, provider, label, credential_ciphertext, credential_iv, credential_kind) values ('00000000-0000-4000-8000-000000000001', 'vercel', 'me', 'x', 'y', 'token')`);
  await db.execute(sql`insert into ops.resources (id, account_id, kind, external_id, name) values ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'app', 'prj_1', 'shop')`);
  await db.execute(sql`insert into ops.resources (id, account_id, kind, external_id, name, parent_id) values ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001', 'domain', 'shop.example', 'shop.example', '00000000-0000-4000-8000-000000000011')`);
  await db.execute(sql`insert into ops.status_pages (slug, title) values ('shop', 'Shop')`);
  await db.execute(sql`insert into ops.reports (client_name) values ('Kopi')`);
  await db.execute(sql`insert into ops.github_repos (account_id, external_id, full_name, name, owner) values ('00000000-0000-4000-8000-000000000001', '1', 'me/shop', 'shop', 'me')`);
  await migrate(db, { migrationsFolder: real });
  h.db = db;
}, 120_000);

afterAll(async () => {
  await client?.close();
  if (folder) rmSync(folder, { recursive: true, force: true });
});

describe("the upgrade to workspaces (1.8)", () => {
  it("puts every row in Personal and makes it the default", async () => {
    const list = await listWorkspaces();
    expect(list.map((w) => ({ name: w.name, position: w.position }))).toEqual([{ name: "Personal", position: 0 }]);
    const personal = list[0].id;
    expect(await defaultWorkspaceId()).toBe(personal);
    for (const t of [resources, statusPages, reports, githubRepos]) {
      const rows = await db.select({ ws: t.workspaceId }).from(t);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.ws === personal)).toBe(true);
    }
  });
});

describe("workspace names", () => {
  it("refuses a blank, a 61-character and a duplicate name (case-insensitive)", async () => {
    expect(await createWorkspace("  ")).toEqual({ error: "name" });
    expect(await createWorkspace("x".repeat(61))).toEqual({ error: "name" });
    expect(await createWorkspace("personal")).toEqual({ error: "taken" });
    const made = await createWorkspace("  Kopi Senja ");
    if (!("id" in made)) throw new Error("not created");
    expect((await listWorkspaces()).map((w) => w.name)).toEqual(["Personal", "Kopi Senja"]);
    expect(await renameWorkspace(made.id, "PERSONAL")).toBe("taken");
    expect(await renameWorkspace(made.id, "Kopi Senja Coffee")).toBe("ok");
    expect(await renameWorkspace("00000000-0000-4000-8000-0000000000ff", "A")).toBe("not-found");
  });

  it("reorders", async () => {
    const [p, k] = await listWorkspaces();
    await reorderWorkspaces([k.id, p.id]);
    expect((await listWorkspaces()).map((w) => w.name)).toEqual(["Kopi Senja Coffee", "Personal"]);
    await reorderWorkspaces([p.id, k.id]);
  });
});

describe("deleting a workspace", () => {
  it("refuses the default and the last, and moves everything else to the default", async () => {
    const personal = await defaultWorkspaceId();
    expect(await deleteWorkspace(personal)).toEqual({ error: "default" });
    const made = await createWorkspace("Northwind");
    if (!("id" in made)) throw new Error("not created");
    const [acc] = await db.select({ id: accounts.id }).from(accounts);
    const [app] = await db.insert(resources).values({ accountId: acc.id, kind: "app", externalId: "prj_2", name: "north", workspaceId: made.id }).returning();
    await db.insert(resources).values({ accountId: acc.id, kind: "domain", externalId: "north.example", name: "north.example", parentId: app.id, workspaceId: made.id });
    await db.insert(statusPages).values({ slug: "north", title: "North", workspaceId: made.id });
    await db.insert(reports).values({ clientName: "North", workspaceId: made.id });
    expect(await deleteWorkspace(made.id)).toEqual({ moved: 3, statusPageRemoved: true });
    expect((await db.select().from(resources).where(eq(resources.workspaceId, personal))).length).toBe(4);
    expect((await db.select().from(statusPages).where(eq(statusPages.slug, "north"))).length).toBe(0);
    expect(await deleteWorkspace(made.id)).toEqual({ error: "not-found" });
  });

  it("the last workspace can't go, even after the default moved", async () => {
    const all = await listWorkspaces();
    const other = all.find((w) => w.id !== (all[0].id));
    if (!other) throw new Error("need two");
    expect(await setDefaultWorkspace(other.id)).toBe(true);
    expect(await deleteWorkspace(all[0].id)).toMatchObject({ moved: expect.any(Number) });
    expect(await deleteWorkspace(other.id)).toEqual({ error: "default" });
    expect(await setDefaultWorkspace("00000000-0000-4000-8000-0000000000ff")).toBe(false);
  });
});

// Watchbell 1.8 (spec §5, All workspaces): one row per workspace with its worst state; install alerts (no resource)
// are counted apart, once.
describe("workspaceSummaries", () => {
  it("gives each workspace its worst state and counts", async () => {
    const made = await createWorkspace("Summary Client");
    if (!("id" in made)) throw new Error("not created");
    const [acc] = await db.select({ id: accounts.id }).from(accounts);
    const [app] = await db.insert(resources).values({ accountId: acc.id, kind: "app", externalId: "prj_s", name: "sum-app", monitored: true, workspaceId: made.id }).returning();
    await db.insert(monitors).values({ resourceId: app.id, url: "https://sum.example/", state: "err" });
    await db.insert(alertRules).values([{ key: "MonitorDown", severity: "critical" }, { key: "CollectorStale", severity: "warning" }]).onConflictDoNothing();
    const t = new Date("2026-11-15T03:00:00Z");
    await db.insert(alerts).values([
      { ruleKey: "MonitorDown", subject: "m", resourceId: app.id, severity: "critical", title: "down", message: "x", startedAt: t, lastSeenAt: t },
      { ruleKey: "CollectorStale", subject: "collector", severity: "warning", title: "stale", message: "x", startedAt: t, lastSeenAt: t },
    ]);
    await db.insert(deployments).values({ resourceId: app.id, externalId: "dpl_s", state: "READY", createdAtProvider: t });
    const sums = await workspaceSummaries(new Date("2026-11-15T04:00:00Z"));
    const row = sums.workspaces.find((w) => w.id === made.id);
    expect(row).toMatchObject({ name: "Summary Client", worst: "down", apps: 1, monitorsDown: 1, openAlerts: 1, lastDeployAt: t });
    expect(sums.workspaces.find((w) => w.id !== made.id)).toMatchObject({ worst: "ok", monitorsDown: 0, openAlerts: 0 });
    expect(sums.install).toEqual({ openAlerts: 1 });
  });
});

// Watchbell 1.8 (spec §5): linking a repo to an app puts it in the app's workspace, unless an app in another workspace
// uses it too (a monorepo stays where it is).
describe("repoFollowsApp", () => {
  it("moves a repo to its app's workspace, but not a repo shared with another workspace's app", async () => {
    const a = await createWorkspace("Repo Client A");
    const b = await createWorkspace("Repo Client B");
    if (!("id" in a) || !("id" in b)) throw new Error("not created");
    const [acc] = await db.select({ id: accounts.id }).from(accounts);
    const [appA] = await db.insert(resources).values({ accountId: acc.id, kind: "app", externalId: "prj_ra", name: "ra", workspaceId: a.id }).returning();
    const [appB] = await db.insert(resources).values({ accountId: acc.id, kind: "app", externalId: "prj_rb", name: "rb", workspaceId: b.id }).returning();
    const [solo] = await db.insert(githubRepos).values({ accountId: acc.id, externalId: "r1", owner: "me", name: "solo", fullName: "me/solo" }).returning();
    const [mono] = await db.insert(githubRepos).values({ accountId: acc.id, externalId: "r2", owner: "me", name: "mono", fullName: "me/mono" }).returning();
    await db.insert(appRepos).values({ appId: appA.id, repoId: solo.id, source: "manual" });
    expect(await repoFollowsApp(solo.id, appA.id)).toBe(true);
    // One repo per app (app_repos is keyed by app): a second app in A uses the monorepo, and B's app too.
    const [appA2] = await db.insert(resources).values({ accountId: acc.id, kind: "app", externalId: "prj_ra2", name: "ra2", workspaceId: a.id }).returning();
    await db.insert(appRepos).values([{ appId: appA2.id, repoId: mono.id, source: "manual" }, { appId: appB.id, repoId: mono.id, source: "manual" }]);
    expect(await repoFollowsApp(mono.id, appB.id)).toBe(false);
    const ws = async (id: string) => (await db.select({ ws: githubRepos.workspaceId }).from(githubRepos).where(eq(githubRepos.id, id)))[0].ws;
    expect(await ws(solo.id)).toBe(a.id);
    expect(await ws(mono.id)).toBe(await defaultWorkspaceId());
  });
});

// Watchbell 1.8: which workspace an alert belongs to — its resource's; ReportSendFailed its report's; none for the
// install's own alerts.
describe("alertWorkspaceIds", () => {
  it("maps alerts to their resource's or report's workspace, and leaves install alerts out", async () => {
    const made = await createWorkspace("Alert Client");
    if (!("id" in made)) throw new Error("not created");
    const [acc] = await db.select({ id: accounts.id }).from(accounts);
    const [app] = await db.insert(resources).values({ accountId: acc.id, kind: "app", externalId: "prj_al", name: "al", workspaceId: made.id }).returning();
    const [rep] = await db.insert(reports).values({ clientName: "Alert Client", workspaceId: made.id }).returning();
    const map = await alertWorkspaceIds([
      { id: "x1", resourceId: app.id, ruleKey: "MonitorDown", subject: "m" },
      { id: "x2", resourceId: null, ruleKey: "ReportSendFailed", subject: rep.id },
      { id: "x3", resourceId: null, ruleKey: "CollectorStale", subject: "collector" },
    ]);
    expect(map.get("x1")).toBe(made.id);
    expect(map.get("x2")).toBe(made.id);
    expect(map.has("x3")).toBe(false);
  });
});

// Watchbell 1.8 (spec §5, Moving): an app moves with its domains and its history (which follows by resource), a
// domain or child id moves its app, linked repos follow unless an app elsewhere uses them; the move marks it sorted.
describe("moveResources", () => {
  it("moves an app with its domains and repo, resolving a child id to its app, keeping history", async () => {
    const from = await createWorkspace("Move From");
    const to = await createWorkspace("Move To");
    if (!("id" in from) || !("id" in to)) throw new Error("not created");
    const [acc] = await db.select({ id: accounts.id }).from(accounts);
    const [app] = await db.insert(resources).values({ accountId: acc.id, kind: "app", externalId: "prj_mv", name: "mv", workspaceId: from.id }).returning();
    const [dom] = await db.insert(resources).values({ accountId: acc.id, kind: "domain", externalId: "mv.example", name: "mv.example", parentId: app.id, workspaceId: from.id }).returning();
    const [m] = await db.insert(monitors).values({ resourceId: app.id, url: "https://mv.example/" }).returning();
    const [repo] = await db.insert(githubRepos).values({ accountId: acc.id, externalId: "r_mv", owner: "me", name: "mv", fullName: "me/mv", workspaceId: from.id }).returning();
    await db.insert(appRepos).values({ appId: app.id, repoId: repo.id, source: "manual" });
    expect(await moveResources([dom.id], to.id)).toEqual({ moved: 1, children: 1, repos: 1 });
    const ws = async (id: string) => (await db.select({ ws: resources.workspaceId, sorted: resources.sortedAt }).from(resources).where(eq(resources.id, id)))[0];
    expect((await ws(app.id)).ws).toBe(to.id);
    expect((await ws(app.id)).sorted).not.toBeNull();
    expect((await ws(dom.id)).ws).toBe(to.id);
    expect((await db.select().from(monitors).where(eq(monitors.id, m.id))).length).toBe(1);
    expect((await db.select({ ws: githubRepos.workspaceId }).from(githubRepos).where(eq(githubRepos.id, repo.id)))[0].ws).toBe(to.id);
    expect(await moveResources(["00000000-0000-4000-8000-0000000000ff"], to.id)).toEqual({ moved: 0, children: 0, repos: 0 });
  });

  it("moves repositories on their own", async () => {
    const to = await createWorkspace("Repo Target");
    if (!("id" in to)) throw new Error("not created");
    const [acc] = await db.select({ id: accounts.id }).from(accounts);
    const [repo] = await db.insert(githubRepos).values({ accountId: acc.id, externalId: "r_alone", owner: "me", name: "alone", fullName: "me/alone" }).returning();
    expect(await moveRepos([repo.id], to.id)).toBe(1);
  });
});

// Final review (1.8, I2): All workspaces counts what the pages show — watched apps only, a paused or owner-paused
// monitor is not "down", and ReportSendFailed counts for its report's workspace, not the install.
describe("workspaceSummaries counts like the pages", () => {
  it("leaves out unwatched apps and paused monitors, and files a report alert under its workspace", async () => {
    const made = await createWorkspace("Count Client");
    if (!("id" in made)) throw new Error("not created");
    const [acc] = await db.select({ id: accounts.id }).from(accounts);
    const [watched] = await db.insert(resources).values({ accountId: acc.id, kind: "app", externalId: "prj_c1", name: "c1", monitored: true, workspaceId: made.id }).returning();
    await db.insert(resources).values({ accountId: acc.id, kind: "app", externalId: "prj_c2", name: "c2", monitored: false, workspaceId: made.id });
    await db.insert(monitors).values([{ resourceId: watched.id, url: "https://c1.example/a", state: "err", paused: true }, { resourceId: watched.id, url: "https://c1.example/b", state: "err", ownerPaused: true }]);
    const [rep] = await db.insert(reports).values({ clientName: "Count Client", workspaceId: made.id }).returning();
    await db.insert(alertRules).values({ key: "ReportSendFailed", severity: "warning" }).onConflictDoNothing();
    const t = new Date("2026-11-15T03:00:00Z");
    const before = (await workspaceSummaries(t)).install.openAlerts;
    await db.insert(alerts).values({ ruleKey: "ReportSendFailed", subject: rep.id, severity: "warning", title: "r", message: "x", startedAt: t, lastSeenAt: t });
    const sums = await workspaceSummaries(t);
    expect(sums.workspaces.find((w) => w.id === made.id)).toMatchObject({ apps: 1, monitorsDown: 0, openAlerts: 1, worst: "warn" });
    expect(sums.install.openAlerts).toBe(before);
  });
});
