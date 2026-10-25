import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectorRuns, settings } from "@/db/schema";
import { fakeDb, payloadOf } from "@/lib/data/fake-db";

// runCollector's trigger handling: the selfhost scheduler ("builtin") is a scheduled tick like cron-job.org, so each
// task keeps its own interval (force = false), and it is stored as "manual" (collector_runs.trigger has no "builtin").
const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown }, dueTasks: vi.fn() }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), updateTag: vi.fn() }));
vi.mock("./lease", () => ({ acquireLease: async () => "owner-1", releaseLease: async () => {} }));
vi.mock("./schedule", async (orig) => ({ ...(await orig<typeof import("./schedule")>()), dueTasks: h.dueTasks }));
// Watchbell 1.2 (D11): the sections the owner turned off (none unless a test says so).
const sec = vi.hoisted(() => ({ paused: new Set<string>() }));
vi.mock("@/lib/data/sections-db", () => ({ pausedSections: async () => sec.paused }));
// Watchbell 1.2.1: the security task itself is tested in lib/data/security-task.test.ts.
const security = vi.hoisted(() => ({ task: vi.fn() }));
vi.mock("@/lib/data/security-task", async (orig) => ({ ...(await orig<typeof import("@/lib/data/security-task")>()), taskSecurity: security.task }));

import { runCollector } from "./run";

beforeEach(() => {
  sec.paused = new Set();
  h.dueTasks.mockReset().mockReturnValue([]); // nothing due: the run only opens and closes its collector_runs row
  security.task.mockReset().mockResolvedValue({ complete: true });
  vi.spyOn(console, "info").mockImplementation(() => {});
});

async function runWith(trigger: Parameters<typeof runCollector>[0]) {
  const f = fakeDb([], [[{ id: "run-1" }]]);
  h.current = f;
  const summary = await runCollector(trigger);
  const insert = f.writes.find((w) => w.kind === "insert" && w.table === collectorRuns);
  return { summary, stored: payloadOf(insert?.calls ?? [])?.trigger, force: h.dueTasks.mock.calls[0]?.[2], paused: h.dueTasks.mock.calls[0]?.[3] };
}

describe("runCollector trigger", () => {
  it('"builtin" (selfhost scheduler) respects task intervals and is stored as "manual"', async () => {
    const r = await runWith("builtin");
    expect(r.summary.skipped).toBe(false);
    expect(r.force).toBe(false);
    expect(r.stored).toBe("manual");
  });
  it('"cron_job_org" respects task intervals and is stored as itself', async () => {
    const r = await runWith("cron_job_org");
    expect(r.force).toBe(false);
    expect(r.stored).toBe("cron_job_org");
  });
  it("asks for the due tasks without the paused sections' ones (D11)", async () => {
    sec.paused = new Set(["database"]);
    expect([...(await runWith("cron_job_org")).paused]).toEqual(["database"]);
  });
  it('"manual" (Refresh now) forces every task', async () => {
    const r = await runWith("manual");
    expect(r.force).toBe(true);
    expect(r.stored).toBe("manual");
  });
});

// Watchbell 1.2.1: an app marked after a new production deployment starts the security task in the next run, outside
// its 6-hourly slot; that early run isn't saved as the task's last run, so the slot still comes.
describe("runCollector and the after-deploy security check", () => {
  const APP = "11111111-1111-4111-8111-111111111111";
  const marks = { key: "security.afterDeploy", value: { pending: { [APP]: { id: "dpl_new", at: new Date().toISOString() } }, checked: {} } };
  const lastRunWrite = (f: ReturnType<typeof fakeDb>) => f.writes.filter((w) => w.kind === "insert" && w.table === settings).map((w) => payloadOf(w.calls))
    .find((v) => v?.key === "collector.lastRun")?.value as Record<string, string> | undefined;

  it("a marked app: the security task runs early (marked apps only) and its slot is kept", async () => {
    const f = fakeDb([[marks]], [[{ id: "run-1" }]]);
    h.current = f;
    const r = await runCollector("cron_job_org");
    expect(security.task).toHaveBeenCalledWith(expect.objectContaining({ early: true }));
    expect(r.tasks).toEqual(["security"]);
    expect(lastRunWrite(f)).toEqual({});
  });

  it("nothing marked: no security task outside its slot", async () => {
    h.current = fakeDb([[{ key: "security.afterDeploy", value: { pending: {}, checked: { [APP]: "dpl_new" } } }]], [[{ id: "run-1" }]]);
    await runCollector("cron_job_org");
    expect(security.task).not.toHaveBeenCalled();
  });

  it("the 6-hourly slot: a full run, saved as the task's last run", async () => {
    h.dueTasks.mockReturnValue(["security"]);
    const f = fakeDb([[marks]], [[{ id: "run-1" }]]);
    h.current = f;
    await runCollector("cron_job_org");
    expect(security.task).toHaveBeenCalledWith(expect.objectContaining({ early: false }));
    expect(lastRunWrite(f)).toHaveProperty("security");
  });

  // Fix round 1 (review important 1): a slot that couldn't go through every app and repository isn't recorded, so the
  // task stays due and continues in the next minute runs.
  it("a 6-hourly run that didn't finish its lists isn't saved as the task's last run", async () => {
    h.dueTasks.mockReturnValue(["security"]);
    security.task.mockResolvedValue({ complete: false });
    const f = fakeDb([[]], [[{ id: "run-1" }]]);
    h.current = f;
    const r = await runCollector("cron_job_org");
    expect(r.tasks).toEqual(["security"]);
    expect(lastRunWrite(f)).not.toHaveProperty("security");
  });
});
