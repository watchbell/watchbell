import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const member = { id: "mem-1", userId: "user-1", email: "op@example.com", role: "operator" as const };

const h = vi.hoisted(() => ({
  requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), recordAction: vi.fn(), silenceAlert: vi.fn(), saveRule: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/data/alerts-db", () => ({ silenceAlert: h.silenceAlert, saveRule: h.saveRule }));

import { LIMITS } from "@/lib/rate-limit";
import { editRule, silence } from "./actions";

const form = { severity: "critical", threshold: "2,000", channels: ["telegram"], enabled: true };

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(member);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.silenceAlert.mockResolvedValue({ ruleKey: "MonitorDown", title: "web /", resourceId: "app-1" });
  h.saveRule.mockResolvedValue(true);
  h.recordAction.mockResolvedValue(undefined);
});

describe("silence (Owner, Operator)", () => {
  it("needs an operator: a viewer is refused before any limit or write", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await silence(UUID, "1h")).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("operator");
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.silenceAlert).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("rejects a malformed id or choice before the limit and the database", async () => {
    expect(await silence("nope", "1h")).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(await silence(UUID, "forever" as never)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.silenceAlert).not.toHaveBeenCalled();
  });

  it("is rate limited per member", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 120 });
    expect(await silence(UUID, "1h")).toEqual({ ok: false, error: "Too many changes. Try again in 2 minutes." });
    expect(h.limit).toHaveBeenCalledWith(LIMITS.alertWrite, "mem-1");
    expect(h.silenceAlert).not.toHaveBeenCalled();
  });

  it("silences, audits and refreshes", async () => {
    const r = await silence(UUID, "resolved");
    expect(r).toEqual({ ok: true, message: "No more notifications for this alert until then." });
    expect(h.silenceAlert).toHaveBeenCalledWith(UUID, "resolved", "user-1", expect.any(Date));
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "Alert silenced until resolved", detail: "MonitorDown · web /", resourceId: "app-1", actorUserId: "user-1" });
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it("says so when the alert already resolved, and writes no audit entry", async () => {
    h.silenceAlert.mockResolvedValue(null);
    expect(await silence(UUID, "1h")).toEqual({ ok: false, error: "That alert has already resolved." });
    expect(h.recordAction).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("still succeeds when the audit entry can't be written", async () => {
    h.recordAction.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await silence(UUID, "off")).ok).toBe(true);
  });
});

describe("editRule (Owner only)", () => {
  it("says so instead of reporting a save when the rule row is missing (M5)", async () => {
    h.saveRule.mockResolvedValue(false);
    const r = await editRule("HighLatency", form);
    expect(r.ok).toBe(false);
    expect(h.recordAction).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("needs an owner: an operator is refused before parsing, any limit or write", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await editRule("HighLatency", form)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.saveRule).not.toHaveBeenCalled();
  });

  it("rejects an unknown rule key and reports field errors without writing", async () => {
    expect(await editRule("Nope", form)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    const bad = await editRule("MonitorDown", { ...form, threshold: "0" });
    expect(bad).toMatchObject({ ok: false, fieldErrors: { threshold: "Enter a whole number from 1 to 10." } });
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.saveRule).not.toHaveBeenCalled();
  });

  it("saves, audits with the new condition and refreshes", async () => {
    const r = await editRule("HighLatency", form);
    expect(r).toEqual({ ok: true, message: "HighLatency: p95 > 2,000 ms for 10 min." });
    expect(h.saveRule).toHaveBeenCalledWith("HighLatency", { severity: "critical", threshold: 2000, channels: ["telegram"], enabled: true });
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "Rule HighLatency saved", detail: "p95 > 2,000 ms for 10 min", resourceId: null, actorUserId: "user-1" });
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it("is rate limited per member", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 30 });
    expect(await editRule("HighLatency", form)).toEqual({ ok: false, error: "Too many changes. Try again in 1 minute." });
    expect(h.saveRule).not.toHaveBeenCalled();
  });
});
