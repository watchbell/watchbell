import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const owner = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), recordAction: vi.fn(), guard: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/data/pool-guard", () => ({ guardPool: h.guard }));

import { closeIdleConnections } from "./pool-actions";

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(owner);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.recordAction.mockResolvedValue(undefined);
  h.guard.mockResolvedValue({ trimmed: 2, total: 5 });
});
afterEach(() => vi.unstubAllEnvs());

describe("closeIdleConnections", () => {
  it("closes idle connections in cloud (mode unset)", async () => {
    vi.stubEnv("WATCHPOST_MODE", "");
    expect(await closeIdleConnections()).toEqual({ ok: true, message: "Closed 2 idle connections." });
    expect(h.guard).toHaveBeenCalledWith(1, 5);
  });

  // Demo refuses it earlier, in runGuarded's demo policy (lib/demo/simulate.ts), with the demo's own words.
  it.each([["selfhost", "Not available in this mode."], ["demo", "Not available in the demo"]])("refuses in %s without touching the pooler", async (m, error) => {
    vi.stubEnv("WATCHPOST_MODE", m);
    expect(await closeIdleConnections()).toEqual({ ok: false, error });
    expect(h.guard).not.toHaveBeenCalled();
  });
});
