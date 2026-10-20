import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const member = { id: "mem-1", userId: "user-1", email: "op@example.com", role: "operator" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), updateTag: vi.fn(), recheckDomain: vi.fn(), recordAction: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh, updateTag: h.updateTag }));
vi.mock("@/lib/data/network-db", () => ({ recheckDomain: h.recheckDomain }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));

import { recheck } from "./actions";

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.requireActionMember.mockResolvedValue(member);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.recheckDomain.mockResolvedValue({ ok: true, message: "Checked web.example.com.", audit: { message: "Re-check: web.example.com", resourceId: ID } });
});

describe("Domains → Re-check (perf P3)", () => {
  it("expires the cached domain and zone reads after the check wrote them, then refreshes the page", async () => {
    expect(await recheck(ID)).toEqual({ ok: true, message: "Checked web.example.com." });
    expect(h.updateTag.mock.calls).toEqual([["net:domains"], ["net:zones"]]);
    // refresh() first: called after updateTag it would downgrade the action to "dynamic only" (review m2).
    expect(h.refresh.mock.invocationCallOrder[0]).toBeLessThan(h.updateTag.mock.invocationCallOrder[0]);
  });
  it("expires nothing when nothing was checked", async () => {
    h.recheckDomain.mockResolvedValue({ ok: false, error: "That domain is no longer watched." });
    expect(await recheck(ID)).toEqual({ ok: false, error: "That domain is no longer watched." });
    expect(await recheck("nope")).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(h.updateTag).not.toHaveBeenCalled();
  });
});
