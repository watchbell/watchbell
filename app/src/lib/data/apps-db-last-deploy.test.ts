import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { accounts, deployments, resources } from "@/db/schema";
import { type AfterDeploy, type DeployMark, markDeploys, parseAfterDeploy } from "@/lib/security/after-deploy";

// Watchbell 1.2.2 (D16): Last deploy is the deployment production serves, also after a promote or roll back to an older
// one, and a change of the serving deployment marks the app for the after-deploy security check once. Real SQL (PGlite).
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), updateTag: vi.fn() }));

import { updateCurrentFlags } from "@/lib/collector/run";
import { listApps } from "./apps-db";
import { listDeployments } from "./deployments-db";

type Drizzle = ReturnType<typeof drizzle<typeof schema>>;
const NOW = new Date("2026-10-25T10:00:00Z");
const opened: PGlite[] = [];
let d: Drizzle;
let client: PGlite;
let appId = "";

const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
async function deploy(id: string, hoursAgo: number, state = "ready", target = "production") {
  await d.insert(deployments).values({
    resourceId: appId, externalId: id, state, target, branch: "main", commitSha: `${id.slice(4)}000000`, commitMessage: id,
    url: `${id}.example.com`, createdAtProvider: at(hoursAgo), readyAt: state === "ready" ? at(hoursAgo) : null,
  });
}
const lastDeploy = async () => (await listApps(NOW))[0].lastDeploy?.externalId ?? null;

// One collector run of the flag update, as taskVercel makes it: Vercel names `serving` as production's deployment.
// The `ready` list copies taskVercel's READY-production query (collector/run.ts) rather than calling it: a change there
// must be mirrored here.
async function run(serving: string | null, state: AfterDeploy, now = NOW) {
  const ready = await d.select({ resourceId: deployments.resourceId, id: deployments.externalId, createdAt: deployments.createdAtProvider })
    .from(deployments).where(and(eq(deployments.state, "ready"), eq(deployments.target, "production")));
  const marks: DeployMark[][] = [];
  const errors: string[] = [];
  await updateCurrentFlags([{ id: appId, externalId: "prj_web" }], ready, new Map([["prj_web", serving]]), { now, afterDeploy: state, errors, label: "acme" },
    async (m) => { marks.push([...m]); return true; });
  expect(errors).toEqual([]);
  const next = marks.length ? markDeploys(state, marks.flat(), now).state : state;
  return { marked: marks.flat().map((m) => m.deploymentId), state: next };
}

beforeEach(async () => {
  client = await PGlite.create();
  opened.push(client);
  d = drizzle({ client, schema });
  await migrate(d, { migrationsFolder: selfhostMigrationsFolder() });
  h.db = d;
  const [acc] = await d.insert(accounts).values({ provider: "vercel", label: "acme", credentialCiphertext: "x", credentialIv: "x", credentialKind: "token" }).returning();
  const [app] = await d.insert(resources).values({ accountId: acc.id, kind: "app", externalId: "prj_web", name: "web", monitored: true, meta: { teamId: "team_a" } }).returning();
  appId = app.id;
});

afterAll(async () => {
  await Promise.all(opened.map((c) => c.close()));
});

describe("Last deploy is the deployment production serves (D16)", () => {
  it("a normal deploy: the newest READY one is current, Last deploy, and marked once", async () => {
    await deploy("dpl_old", 48);
    await deploy("dpl_new", 1);
    const first = await run("dpl_new", parseAfterDeploy(null));
    expect(first.marked).toEqual(["dpl_new"]);
    expect(await lastDeploy()).toBe("dpl_new");
    const again = await run("dpl_new", first.state);
    expect(again.marked).toEqual([]);
  });

  it("a promote to an older deployment: Last deploy and the Current badge follow it, and it is marked once", async () => {
    await deploy("dpl_a", 72);
    await deploy("dpl_b", 48);
    await deploy("dpl_c", 2);
    const before = await run("dpl_c", parseAfterDeploy(null));
    expect(before.marked).toEqual(["dpl_c"]);
    expect(await lastDeploy()).toBe("dpl_c");

    // Promoted dpl_a (older than the TTL, so only the flag change can mark it).
    const promoted = await run("dpl_a", before.state);
    expect(promoted.marked).toEqual(["dpl_a"]);
    expect(await lastDeploy()).toBe("dpl_a");
    const rows = await listDeployments({ appId });
    expect(rows.filter((r) => r.isCurrent).map((r) => r.externalId)).toEqual(["dpl_a"]);

    // The next minute's run changes nothing and marks nothing.
    const later = await run("dpl_a", promoted.state);
    expect(later.marked).toEqual([]);
    expect(await lastDeploy()).toBe("dpl_a");

    // Promoting the newest one back is a change of the serving deployment again.
    const back = await run("dpl_c", later.state);
    expect(back.marked).toEqual(["dpl_c"]);
    expect(await lastDeploy()).toBe("dpl_c");
  });

  it("a roll back keeps Last deploy on its target while a newer push is built but stays staged", async () => {
    await deploy("dpl_prev", 30);
    await deploy("dpl_cur", 20);
    const live = await run("dpl_cur", parseAfterDeploy(null));
    const rolled = await run("dpl_prev", live.state);
    expect(rolled.marked).toEqual(["dpl_prev"]);
    await deploy("dpl_staged", 1);
    const staged = await run("dpl_prev", rolled.state);
    expect(staged.marked).toEqual([]);
    expect(await lastDeploy()).toBe("dpl_prev");
  });

  it("a newer production build that is running or failed still shows, as before", async () => {
    await deploy("dpl_live", 30);
    await run("dpl_live", parseAfterDeploy(null));
    await deploy("dpl_fail", 2, "error");
    expect(await lastDeploy()).toBe("dpl_fail");
    await deploy("dpl_build", 1, "building");
    expect(await lastDeploy()).toBe("dpl_build");
  });

  it("an unfinished build older than the serving one doesn't hide it", async () => {
    await deploy("dpl_fail", 40, "error");
    await deploy("dpl_a", 30);
    await deploy("dpl_b", 20);
    await run("dpl_a", parseAfterDeploy(null));
    expect(await lastDeploy()).toBe("dpl_a");
  });

  it("without a current flag (before the collector placed one) the newest production deployment is shown, as before", async () => {
    await deploy("dpl_a", 30);
    await deploy("dpl_b", 20);
    await deploy("dpl_preview", 1, "ready", "preview");
    expect(await lastDeploy()).toBe("dpl_b");
  });

  it("another app's current flag doesn't count for this one", async () => {
    await deploy("dpl_a", 30);
    await deploy("dpl_b", 20);
    const [acc] = await d.select().from(accounts);
    const [other] = await d.insert(resources).values({ accountId: acc.id, kind: "app", externalId: "prj_api", name: "api", monitored: true }).returning();
    await d.insert(deployments).values({
      resourceId: other.id, externalId: "dpl_api", state: "ready", target: "production", createdAtProvider: at(5), isCurrent: true,
    });
    const byName = new Map((await listApps(NOW)).map((a) => [a.name, a.lastDeploy?.externalId ?? null]));
    expect(byName).toEqual(new Map([["api", "dpl_api"], ["web", "dpl_b"]]));
  });

  it("a newer canceled build shows; an is_current row that isn't production neither shows nor counts as serving", async () => {
    await deploy("dpl_a", 30);
    await deploy("dpl_b", 20);
    await run("dpl_a", parseAfterDeploy(null));
    await deploy("dpl_cancel", 2, "canceled");
    expect(await lastDeploy()).toBe("dpl_cancel");
    await d.delete(deployments).where(eq(deployments.externalId, "dpl_cancel"));
    // Only a production row is serving: a preview flagged current (never written by the collector) changes nothing.
    await d.update(deployments).set({ isCurrent: false }).where(eq(deployments.resourceId, appId));
    await d.insert(deployments).values({ resourceId: appId, externalId: "dpl_pv", state: "ready", target: "preview", createdAtProvider: at(1), isCurrent: true });
    expect(await lastDeploy()).toBe("dpl_b");
  });

  // Review I1: ~300 rows on 20 apps, every case at once, and the "no current row" check is one hashed subplan, not one
  // correlated lookup per READY row.
  it("many rows on many apps: each app gets its own answer, and the serving check isn't correlated", async () => {
    const [acc] = await d.select().from(accounts);
    const apps = await d.insert(resources).values(Array.from({ length: 20 }, (_, i) => ({
      accountId: acc.id, kind: "app" as const, externalId: `prj_${i}`, name: `app-${String(i).padStart(2, "0")}`, monitored: true,
    }))).returning();
    // Per app 15 production rows, k = 14 the newest. i % 5: 0 no current row; 1 promoted to the old k = 3; 2 current k = 10
    // with a failed k = 12; 3 the newest is current; 4 current k = 5 with an older failed k = 1.
    const plan: Record<number, { current: number | null; error?: number; want: number }> = {
      0: { current: null, want: 14 }, 1: { current: 3, want: 3 }, 2: { current: 10, error: 12, want: 12 }, 3: { current: 14, want: 14 }, 4: { current: 5, error: 1, want: 5 },
    };
    const want = new Map<string, string>();
    await d.insert(deployments).values(apps.flatMap((a, i) => {
      const p = plan[i % 5];
      want.set(a.name, `dpl_${i}_${p.want}`);
      return Array.from({ length: 15 }, (_, k) => ({
        resourceId: a.id, externalId: `dpl_${i}_${k}`, state: k === p.error ? "error" : "ready", target: "production",
        createdAtProvider: at(100 - k), isCurrent: k === p.current,
      }));
    }));
    expect((await d.select().from(deployments)).length).toBe(300);

    const query = vi.spyOn(client, "query");
    const got = new Map((await listApps(NOW)).filter((a) => a.name !== "web").map((a) => [a.name, a.lastDeploy?.externalId]));
    expect(got).toEqual(want);
    const call = query.mock.calls.find(([text]) => /distinct on/i.test(String(text)));
    query.mockRestore();
    expect(call).toBeDefined();
    const explained = await client.query<{ "QUERY PLAN": string }>(`explain ${String(call![0])}`, call![1] as unknown[]);
    const plan2 = explained.rows.map((r) => r["QUERY PLAN"]).join("\n");
    // One uncorrelated subplan, hashed. The correlated NOT EXISTS this replaced planned as two alternatives (a per-row
    // lookup and a hashed one, "SubPlan 2"), leaving the choice to the planner's row estimates.
    expect(plan2).toMatch(/hashed SubPlan 1\b/);
    expect(plan2).not.toMatch(/SubPlan 2/);
  });
});
