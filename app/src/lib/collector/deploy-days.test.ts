import { describe, expect, it, vi } from "vitest";
import { deployDays } from "@/db/report-schema";
import { fakeDb, payloadOf } from "@/lib/data/fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/data/settings-db", () => ({ readRetentionDays: async () => ({ checks: 7, rollupsHourly: 90, deployments: 30, events: 90, alerts: 90, collectorRuns: 14, storedLogs: 7, recommendationDismissals: 90 }) }));

import { stepDeployDays, summarizeDeploys } from "./deploy-days";

const d = (resourceId: string, state: string, iso: string) => ({ resourceId, state, createdAtProvider: new Date(iso) });

// Watchbell 1.7 (spec §5): deployments are deleted after 30 days, so the daily job keeps a per-day summary first.
describe("summarizeDeploys", () => {
  it("counts ready and failed deploys per app and install-zone day, and ignores the rest", () => {
    const rows = [
      d("app-1", "READY", "2026-10-31T18:30:00Z"), // 01:30 WIB on 1 Nov
      d("app-1", "ERROR", "2026-10-31T16:59:00Z"), // 23:59 WIB on 31 Oct
      d("app-1", "READY", "2026-10-31T10:00:00Z"),
      d("app-1", "BUILDING", "2026-10-31T11:00:00Z"),
      d("app-1", "CANCELED", "2026-10-31T12:00:00Z"),
      d("app-2", "READY", "2026-11-01T02:00:00Z"),
    ];
    expect(summarizeDeploys(rows, "Asia/Jakarta")).toEqual([
      { resourceId: "app-1", day: "2026-10-31", ok: 1, failed: 1 },
      { resourceId: "app-1", day: "2026-11-01", ok: 1, failed: 0 },
      { resourceId: "app-2", day: "2026-11-01", ok: 1, failed: 0 },
    ]);
  });

  it("returns nothing for no deploys", () => {
    expect(summarizeDeploys([], "Asia/Jakarta")).toEqual([]);
  });
});

describe("stepDeployDays", () => {
  it("re-counts the recent days and upserts one row per app and day", async () => {
    const f = fakeDb([[{ day: "2026-11-11" }], [d("app-1", "READY", "2026-11-12T03:00:00Z"), d("app-1", "ERROR", "2026-11-12T04:00:00Z")]]);
    h.current = f;
    await stepDeployDays(new Date("2026-11-13T00:00:00Z"), "Asia/Jakarta");
    const ins = f.writes.filter((w) => w.kind === "insert" && w.table === deployDays);
    expect(ins).toHaveLength(1);
    expect(payloadOf(ins[0].calls)).toEqual([{ resourceId: "app-1", day: "2026-11-12", ok: 1, failed: 1 }]);
  });

  it("writes nothing when there were no deploys", async () => {
    const f = fakeDb([[{ day: null }], []]);
    h.current = f;
    await stepDeployDays(new Date("2026-11-13T00:00:00Z"), "Asia/Jakarta");
    expect(f.writes.filter((w) => w.table === deployDays)).toEqual([]);
  });
});

// Final review (1.7.1): the live and previous production deployments are never deleted, so on the first run they would
// make the summary look as if it started months ago. It starts where the deployments table is still complete.
describe("stepDeployDays: the first run (1.7.1)", () => {
  it("summarises only the days the deployments are still all kept for", async () => {
    const f = fakeDb([[{ day: null }], [d("app-1", "READY", "2026-06-02T03:00:00Z"), d("app-1", "READY", "2026-11-12T03:00:00Z")]]);
    h.current = f;
    await stepDeployDays(new Date("2026-11-13T00:00:00Z"), "Asia/Jakarta");
    const ins = f.writes.filter((w) => w.kind === "insert" && w.table === deployDays);
    expect(payloadOf(ins[0].calls)).toEqual([{ resourceId: "app-1", day: "2026-11-12", ok: 1, failed: 0 }]);
  });
});
