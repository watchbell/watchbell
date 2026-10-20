import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const member = { id: "mem-1", userId: "user-1", email: "op@example.com", role: "operator" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), recordAction: vi.fn(), dismiss: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/data/advisor-db", () => ({ dismiss: h.dismiss }));

import { LIMITS } from "@/lib/rate-limit";
import { dismissRecommendation } from "./advisor-actions";

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(member);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.dismiss.mockResolvedValue({ ok: true, title: "The monitor on / answers 401", appId: "a1" });
  h.recordAction.mockResolvedValue(undefined);
});

describe("dismissRecommendation", () => {
  it("needs an operator: a viewer is refused before any limit or database call", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await dismissRecommendation("k")).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("operator");
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.dismiss).not.toHaveBeenCalled();
  });
  it("rejects a key that isn't a string of 1–200 characters", async () => {
    for (const k of ["", "x".repeat(201), 5 as unknown as string]) expect(await dismissRecommendation(k)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(h.dismiss).not.toHaveBeenCalled();
  });
  it("is limited like the other console-row writes", async () => {
    await dismissRecommendation("k");
    expect(h.limit).toHaveBeenCalledWith(LIMITS.monitorWrite, "mem-1");
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 90 });
    expect(await dismissRecommendation("k")).toEqual({ ok: false, error: "Too many changes. Try again in 2 minutes." });
    expect(h.dismiss).toHaveBeenCalledTimes(1);
  });
  it("dismisses, records who did it, refreshes and says when it comes back", async () => {
    const r = await dismissRecommendation("monitor-root:m1:401");
    expect(h.dismiss).toHaveBeenCalledWith("monitor-root:m1:401", "user-1", expect.any(Date));
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "Recommendation dismissed: The monitor on / answers 401", resourceId: "a1", actorUserId: "user-1" });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: true, message: "Dismissed. It comes back in 30 days if it still applies." });
  });
  it("passes a refusal through without an audit entry or refresh", async () => {
    h.dismiss.mockResolvedValue({ ok: false, error: "That item is no longer on the list." });
    expect(await dismissRecommendation("k")).toEqual({ ok: false, error: "That item is no longer on the list." });
    expect(h.recordAction).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });
  it("keeps working when the audit entry can't be written", async () => {
    h.recordAction.mockRejectedValue(new Error("db down"));
    expect(await dismissRecommendation("k")).toMatchObject({ ok: true });
  });
});
