import { describe, expect, it } from "vitest";
import { splitRequests, trimFinished } from "./split";

const NOW = new Date("2026-10-19T12:00:00Z");
const it_ = (id: string, status: string, hoursAgo: number) => ({ id, status: status as never, createdAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString() });

describe("splitRequests", () => {
  it("requested, approved and running are pending; done, failed, rejected and expired are finished", () => {
    const all = ["requested", "approved", "running", "done", "failed", "rejected", "expired"].map((s) => it_(s, s, 1));
    const { pending, finished } = splitRequests(all);
    expect(pending.map((i) => i.id)).toEqual(["requested", "approved", "running"]);
    expect(finished.map((i) => i.id)).toEqual(["done", "failed", "rejected", "expired"]);
  });
});

describe("trimFinished", () => {
  it("drops finished requests older than 24 h, keeps pending ones of any age", () => {
    const out = trimFinished([it_("old", "done", 30), it_("new", "done", 2), it_("wait", "requested", 40)], NOW);
    expect(out.map((i) => i.id)).toEqual(["new", "wait"]);
  });
  it("keeps only the newest few finished ones, in the original order", () => {
    const items = Array.from({ length: 8 }, (_, n) => it_(`f${n}`, "failed", n + 1));
    expect(trimFinished(items, NOW).map((i) => i.id)).toEqual(["f0", "f1", "f2", "f3", "f4"]);
  });
});
