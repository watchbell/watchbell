import { describe, expect, it, vi } from "vitest";

vi.mock("@/db/client", () => ({ db: () => { throw new Error("no database in tests"); } }));

import { decideAndRun, type DecideAndRunDeps } from "./proposals-decide";
import type { Proposal } from "./proposals-types";

const NOW = new Date("2026-10-16T03:00:00.000Z");
const P = { id: "p1", status: "approved" } as Proposal;
const M = { id: "mem-1", userId: "user-1" };

function deps(outcome: Awaited<ReturnType<DecideAndRunDeps["decide"]>>, ran: Proposal | null = { ...P, status: "done" }) {
  const order: string[] = [];
  const d: DecideAndRunDeps = {
    decide: vi.fn(async () => { order.push("decide"); return outcome; }),
    execute: vi.fn(async () => { order.push("execute"); return ran; }),
  };
  return { d, order };
}

describe("decideAndRun (the office route's and Telegram's one path)", () => {
  it("approve: decides as the member, calls onApproved, then runs it as that owner", async () => {
    const { d, order } = deps({ status: "ok", proposal: P });
    const onApproved = vi.fn(async () => { order.push("onApproved"); });
    expect(await decideAndRun("p1", "approve", M, NOW, { onApproved }, d)).toMatchObject({ status: "ok", proposal: { ...P, status: "done" } });
    expect(order).toEqual(["decide", "onApproved", "execute"]);
    expect(d.decide).toHaveBeenCalledWith("p1", "approve", "mem-1", NOW);
    expect(d.execute).toHaveBeenCalledWith("p1", M, expect.any(Date));
  });
  it("a run claimed elsewhere answers the approved proposal", async () => {
    const { d } = deps({ status: "ok", proposal: P }, null);
    expect(await decideAndRun("p1", "approve", M, NOW, {}, d)).toMatchObject({ status: "ok", proposal: P });
  });
  it("reject, conflict and missing never run anything", async () => {
    for (const o of [{ status: "ok", proposal: { ...P, status: "rejected" } }, { status: "conflict", proposal: P }, { status: "missing" }] as const) {
      const { d } = deps(o);
      const r = await decideAndRun("p1", o.status === "ok" ? "reject" : "approve", M, NOW, {}, d);
      expect(r.status).toBe(o.status);
      expect(d.execute).not.toHaveBeenCalled();
    }
  });
});
