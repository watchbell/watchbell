import { beforeEach, describe, expect, it, vi } from "vitest";
import { deployments } from "@/db/schema";
import { fakeDb } from "@/lib/data/fake-db";
import { AFTER_DEPLOY_TTL_MS, markDeploys, parseAfterDeploy, settleMarks } from "@/lib/security/after-deploy";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), updateTag: vi.fn() }));

import { readFileSync } from "node:fs";
import { originsOf, saveProductionSources, updateCurrentFlags } from "./run";

// Watchbell 1.2.2 (D15, review minor 6): the Vercel task records the production source after the current flags; a failed
// write is an error line, never a failed task.
describe("saveProductionSources", () => {
  const apps = [{ id: "11111111-1111-4111-8111-111111111111", meta: {} }];
  const at = new Date("2026-10-25T10:00:00Z");
  it("records the team's apps with the run's time", async () => {
    const record = vi.fn().mockResolvedValue(1);
    const errors: string[] = [];
    const seen = new Map([["dpl_1", { branchFrom: "cli" }]]);
    await saveProductionSources(apps, at, errors, "acme", seen, record);
    expect(record).toHaveBeenCalledWith(apps, at, seen);
    expect(errors).toEqual([]);
  });
  it("a failed write is one error line", async () => {
    const errors: string[] = [];
    await saveProductionSources(apps, at, errors, "acme", new Map(), vi.fn().mockRejectedValue(new Error("db down")));
    expect(errors).toEqual([expect.stringMatching(/^vercel\/acme: production source not saved/)]);
  });
  it("originsOf keeps where each deployment's branch came from", () => {
    const dep = (id: string, o: object) => ({ id, projectId: "p", state: "ready" as const, rawState: "READY", target: "production" as const, branch: "main", sha: null, message: null,
      source: "redeploy", url: null, createdAt: at, buildingAt: null, readyAt: null, ...o });
    expect(originsOf([dep("a", { branchFrom: "cli" }), dep("b", { branchFrom: "github", gitDirty: true }), dep("c", {})])).toEqual(new Map([
      ["a", { branchFrom: "cli" }], ["b", { branchFrom: "github", gitDirty: true }], ["c", {}],
    ]));
  });
  it("taskVercel calls it for the team's apps right after the current flags", () => {
    const src = readFileSync(new URL("./run.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    // Only taskVercel's own body: from its signature to the closing brace at column 0 (review r1 minor 5).
    const start = src.indexOf("async function taskVercel(");
    const end = src.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const task = src.slice(start, end);
    const flags = task.indexOf("await updateCurrentFlags(teamApps, ready, current");
    const save = task.indexOf("await saveProductionSources(teamApps, now, errors, team.name, seen);");
    expect(flags).toBeGreaterThan(0);
    expect(save).toBeGreaterThan(flags);
    // seen: the origins of the deployments listed and of the current ones fetched by id, in the same team loop.
    expect(task.indexOf("const seen = originsOf(mine);")).toBeGreaterThan(0);
    expect(task.indexOf("for (const [k, v] of originsOf([d])) seen.set(k, v);")).toBeGreaterThan(task.indexOf("const d = one.data;"));
    // The very next statement after the flags, in the same team loop (no early return or branch in between).
    expect(task.slice(flags, save).split("\n").filter((l) => l.trim()).length).toBe(1);
  });
});

// Watchbell 1.2.1 (fix round 1, review minors 2 and 5): the Vercel task's current/previous flag update marks an app whose
// production deployment became current, for the security task; a mark that couldn't be saved is made again next run.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-10-24T10:00:00Z");
const recent = new Date(now.getTime() - 60_000);
const old = new Date(now.getTime() - AFTER_DEPLOY_TTL_MS - 60_000);
const apps = [{ id: A, externalId: "prj_a" }];
const ready = (id: string, createdAt: Date, resourceId = A) => ({ resourceId, id, createdAt });

beforeEach(() => { h.current = null; });

async function flags(o: { writes: unknown[]; current?: Map<string, string | null>; ready?: ReturnType<typeof ready>[]; state?: ReturnType<typeof parseAfterDeploy>; apps?: typeof apps; mark?: (marks: readonly unknown[], now: Date) => Promise<boolean> }) {
  const f = fakeDb([], o.writes as never);
  h.current = f;
  const mark = vi.fn(o.mark ?? (async () => true));
  const errors: string[] = [];
  const run = updateCurrentFlags(o.apps ?? apps, o.ready ?? [ready("dpl_new", recent), ready("dpl_prev", old)], o.current ?? new Map([["prj_a", "dpl_new"]]),
    { now, afterDeploy: o.state ?? parseAfterDeploy(null), errors, label: "acme" }, mark);
  return { run, mark, errors, f };
}

describe("updateCurrentFlags", () => {
  it("the update changed the current deployment's row: the app is marked", async () => {
    const { run, mark, f } = await flags({ writes: [[{ id: "dpl_new" }, { id: "dpl_prev" }]], ready: [ready("dpl_new", old), ready("dpl_prev", old)] });
    await run;
    expect(f.writes.map((w) => w.table)).toEqual([deployments]);
    expect(f.writes[0].calls.some((c) => c.method === "returning")).toBe(true);
    expect(mark).toHaveBeenCalledWith([{ appId: A, deploymentId: "dpl_new" }], now);
  });

  it("only the previous flag moved, on an old deployment: nothing to mark", async () => {
    const { run, mark } = await flags({ writes: [[{ id: "dpl_prev" }]], ready: [ready("dpl_new", old), ready("dpl_prev", old)] });
    await run;
    expect(mark).not.toHaveBeenCalled();
  });

  it("a recent current deployment that was never marked (its mark's write failed last run) is marked again", async () => {
    const { run, mark } = await flags({ writes: [[]] });
    await run;
    expect(mark).toHaveBeenCalledWith([{ appId: A, deploymentId: "dpl_new" }], now);
  });

  it("a deployment already waiting or checked is never marked again", async () => {
    const waiting = markDeploys(parseAfterDeploy(null), [{ appId: A, deploymentId: "dpl_new" }], now).state;
    for (const state of [waiting, settleMarks(waiting, [A])]) {
      const { run, mark } = await flags({ writes: [[{ id: "dpl_new" }]], state });
      await run;
      expect(mark).not.toHaveBeenCalled();
    }
  });

  it("an update that throws for a later app keeps the marks of the earlier ones", async () => {
    const { run, mark } = await flags({
      apps: [...apps, { id: B, externalId: "prj_b" }], writes: [[{ id: "dpl_new" }], new Error("db down")],
      current: new Map([["prj_a", "dpl_new"], ["prj_b", "dpl_b"]]), ready: [ready("dpl_new", recent), ready("dpl_b", recent, B)],
    });
    await expect(run).rejects.toThrow("db down");
    expect(mark).toHaveBeenCalledWith([{ appId: A, deploymentId: "dpl_new" }], now);
  });

  it("a mark that can't be saved is an error line, not a failed Vercel task", async () => {
    const { run, errors } = await flags({ writes: [[{ id: "dpl_new" }]], mark: async () => { throw new Error("db down"); } });
    await run;
    expect(errors).toEqual([expect.stringMatching(/^vercel\/acme: after-deploy security check not scheduled/)]);
  });
});
