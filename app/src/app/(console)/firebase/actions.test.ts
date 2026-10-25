import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const operator = { id: "mem-1", userId: "user-1", email: "op@example.com", role: "operator" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), firestoreCheckNow: vi.fn(), paused: new Set<string>() }));
vi.mock("@/lib/data/sections-db", () => ({ pausedSections: async () => h.paused }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("@/lib/collector/db-tasks", () => ({ firestoreCheckNow: h.firestoreCheckNow }));

import { LIMITS } from "@/lib/rate-limit";
import { runHealthCheckAction } from "./actions";

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(operator);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.paused = new Set();
});

// 1.2.1 (4c): Firebase → row menu → Run health check (was "Arrives in stage 6").
describe("runHealthCheckAction", () => {
  it("runs the 5-minute read now and refreshes the page", async () => {
    h.firestoreCheckNow.mockResolvedValue({ ok: true, state: "ok", label: "Reachable · 84 ms" });
    expect(await runHealthCheckAction(UUID)).toEqual({ ok: true, message: "Reachable · 84 ms" });
    expect(h.firestoreCheckNow).toHaveBeenCalledWith(UUID);
    expect(h.refresh).toHaveBeenCalled();
    expect(h.limit).toHaveBeenCalledWith(LIMITS.actionTarget, `health-check:${UUID}`);
  });

  it("a project that isn't reachable is a failure toast with the page's words", async () => {
    h.firestoreCheckNow.mockResolvedValue({ ok: true, state: "err", label: "No access: needs datastore.viewer" });
    expect(await runHealthCheckAction(UUID)).toEqual({ ok: false, error: "No access: needs datastore.viewer" });
  });

  it("needs an operator, a valid id and the per-project cooldown", async () => {
    expect(await runHealthCheckAction("nope")).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    h.limit.mockResolvedValueOnce({ allowed: false, retryAfter: 40 });
    expect((await runHealthCheckAction(UUID)).ok).toBe(false);
    expect(h.firestoreCheckNow).not.toHaveBeenCalled();
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await runHealthCheckAction(UUID)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.firestoreCheckNow).not.toHaveBeenCalled();
  });

  // Review T4c Minor 3: the check writes state and events, which the section switch holds while Database is off.
  it("refuses while the Database section is off", async () => {
    h.paused = new Set(["database"]);
    expect(await runHealthCheckAction(UUID)).toEqual({ ok: false, error: "Database is turned off (Manage › Sections)." });
    expect(h.firestoreCheckNow).not.toHaveBeenCalled();
  });

  it("passes a lookup failure on", async () => {
    h.firestoreCheckNow.mockResolvedValue({ ok: false, error: "This project isn't watched any more." });
    expect(await runHealthCheckAction(UUID)).toEqual({ ok: false, error: "This project isn't watched any more." });
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
