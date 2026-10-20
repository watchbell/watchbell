import { describe, expect, it } from "vitest";
import { proposalsView, statusState } from "./proposals-view";
import type { Proposal } from "./proposals-types";

const p = (id: string, status: Proposal["status"], createdAt: string): Proposal => ({
  id, room: "workloads", action: "recheck", actionLabel: "Check again now", risk: "safe", title: `t-${id}`, reason: "r", resourceName: null,
  proposedBy: "Workloads officer", status, auto: false, result: null, createdAt, decidedAt: null, expiresAt: createdAt,
});

const list = [
  p("a", "pending", "2026-10-18T01:00:00.000Z"),
  p("b", "pending", "2026-10-18T03:00:00.000Z"),
  p("c", "done", "2026-10-18T02:00:00.000Z"),
  p("d", "rejected", "2026-10-18T04:00:00.000Z"),
];

describe("proposalsView", () => {
  it("pending newest first; history without the pending ones, newest first", () => {
    const v = proposalsView(list, null);
    expect(v.pending.map((x) => x.id)).toEqual(["b", "a"]);
    expect(v.history.map((x) => x.id)).toEqual(["d", "c"]);
    expect(v.focus).toBeNull();
  });

  it("finds the focused proposal in the list, or null", () => {
    expect(proposalsView(list, "c").focus?.id).toBe("c");
    expect(proposalsView(list, "zzz").focus).toBeNull();
  });

  it("drops a duplicate id (the focused one read again) and keeps the input untouched", () => {
    const v = proposalsView([...list, list[2]], "c");
    expect(v.history.map((x) => x.id)).toEqual(["d", "c"]);
    expect(list.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("statusState", () => {
  it("maps every status to a console state", () => {
    expect(statusState("done")).toBe("ok");
    expect(statusState("failed")).toBe("fail");
    expect(statusState("running")).toBe("build");
    expect(statusState("approved")).toBe("build");
    expect(statusState("rejected")).toBe("off");
    expect(statusState("expired")).toBe("idle");
    expect(statusState("pending")).toBe("info");
  });
});
