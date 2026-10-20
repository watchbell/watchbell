import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const owner = { id: "mem-1", userId: "user-1", email: "o@example.com", role: "owner" as const };

const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), recordAction: vi.fn(), setLimits: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/private/ui/deps", () => ({ setLimits: h.setLimits }));

import { saveLimits } from "./actions";
import { parseLimits } from "./limits";

const good = [{ metric: "requests", scope: "all", limit: "1,000", window: "day" }];

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(owner);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.setLimits.mockResolvedValue({ ok: true, message: "Limits saved." });
  h.recordAction.mockResolvedValue(undefined);
});

describe("parseLimits", () => {
  it("accepts a limit with a thousands separator and defaults the scope to all", () => {
    expect(parseLimits(good)).toEqual({ ok: true, value: [{ metric: "requests", scope: "all", limit: 1000, window: "day" }] });
    expect(parseLimits([{ metric: "tokens", scope: " ", limit: 5, window: "week" }])).toMatchObject({ ok: true });
  });
  it("rejects what isn't a limit", () => {
    for (const bad of [
      "x", [{ metric: "neurons", limit: 1, window: "day" }], [{ metric: "requests", limit: 1, window: "year" }],
      [{ metric: "requests", limit: 0, window: "day" }], [{ metric: "requests", limit: 1.5, window: "day" }], [{ metric: "requests", limit: 3e9, window: "day" }],
      [{ metric: "requests", scope: "a b", limit: 1, window: "day" }],
      [{ metric: "requests", limit: 1, window: "day" }, { metric: "requests", limit: 2, window: "day" }],
      Array.from({ length: 11 }, (_, i) => ({ metric: "requests", scope: `m${i}`, limit: 1, window: "day" })),
    ]) expect(parseLimits(bad).ok, JSON.stringify(bad).slice(0, 60)).toBe(false);
  });
});

describe("saveLimits", () => {
  it("is owner only (the guard is asked for owner)", async () => {
    await saveLimits(UUID, good);
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
  });
  it("saves, audits and refreshes", async () => {
    const r = await saveLimits(UUID, good);
    expect(r).toEqual({ ok: true, message: "Limits saved." });
    expect(h.setLimits).toHaveBeenCalledWith(UUID, [{ metric: "requests", scope: "all", limit: 1000, window: "day" }]);
    expect(h.recordAction).toHaveBeenCalledOnce();
    expect(h.refresh).toHaveBeenCalledOnce();
  });
  it("refuses a non-owner before touching anything", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await saveLimits(UUID, good)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.setLimits).not.toHaveBeenCalled();
  });
  it("rejects a bad id or bad limits without writing", async () => {
    expect((await saveLimits("nope", good)).ok).toBe(false);
    expect((await saveLimits(UUID, [{ metric: "x" }])).ok).toBe(false);
    expect(h.setLimits).not.toHaveBeenCalled();
  });
  it("stops at the rate limit", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 120 });
    const r = await saveLimits(UUID, good);
    expect(r.ok).toBe(false);
    expect(h.setLimits).not.toHaveBeenCalled();
  });
  it("passes on the provider layer's refusal and writes no audit entry", async () => {
    h.setLimits.mockResolvedValue({ ok: false, error: "That connection no longer exists." });
    expect(await saveLimits(UUID, good)).toEqual({ ok: false, error: "That connection no longer exists." });
    expect(h.recordAction).not.toHaveBeenCalled();
  });
  it("a failed audit entry doesn't undo the change", async () => {
    h.recordAction.mockRejectedValue(new Error("db"));
    expect((await saveLimits(UUID, good)).ok).toBe(true);
  });
});
