import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectorRuns } from "@/db/schema";
import { fakeDb, payloadOf } from "@/lib/data/fake-db";

// runCollector's trigger handling: the selfhost scheduler ("builtin") is a scheduled tick like cron-job.org, so each
// task keeps its own interval (force = false), and it is stored as "manual" (collector_runs.trigger has no "builtin").
const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown }, dueTasks: vi.fn() }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), updateTag: vi.fn() }));
vi.mock("./lease", () => ({ acquireLease: async () => "owner-1", releaseLease: async () => {} }));
vi.mock("./schedule", async (orig) => ({ ...(await orig<typeof import("./schedule")>()), dueTasks: h.dueTasks }));

import { runCollector } from "./run";

beforeEach(() => {
  h.dueTasks.mockReset().mockReturnValue([]); // nothing due: the run only opens and closes its collector_runs row
  vi.spyOn(console, "info").mockImplementation(() => {});
});

async function runWith(trigger: Parameters<typeof runCollector>[0]) {
  const f = fakeDb([], [[{ id: "run-1" }]]);
  h.current = f;
  const summary = await runCollector(trigger);
  const insert = f.writes.find((w) => w.kind === "insert" && w.table === collectorRuns);
  return { summary, stored: payloadOf(insert?.calls ?? [])?.trigger, force: h.dueTasks.mock.calls[0]?.[2] };
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
  it('"manual" (Refresh now) forces every task', async () => {
    const r = await runWith("manual");
    expect(r.force).toBe(true);
    expect(r.stored).toBe("manual");
  });
});
