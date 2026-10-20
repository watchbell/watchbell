import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const APP = "6f0d4c1e-7c55-4a0b-9d2e-1a2b3c4d5e6f";
const member = { id: "mem-1", userId: "user-1", email: "op@example.com", role: "operator" as const };

const h = vi.hoisted(() => ({
  requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), recordAction: vi.fn(),
  createWindow: vi.fn(), updateWindow: vi.fn(), deleteWindow: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/data/maintenance-db", () => ({ createWindow: h.createWindow, updateWindow: h.updateWindow, deleteWindow: h.deleteWindow }));

import { LIMITS } from "@/lib/rate-limit";
import { addWindow, editWindow, removeWindow } from "./maintenance-actions";

const form = { scope: "app", targetId: APP, start: "2026-10-13T22:00", durationMin: "90", weekly: false, note: "DNS move" };
const audit = { message: "Maintenance window added: web", resourceId: APP };
const parsed = { scope: "app", appId: APP, monitorId: null, startsAt: new Date("2026-10-13T15:00:00Z"), durationMin: 90, weekly: false, note: "DNS move" };

const all = [
  ["addWindow", () => addWindow(form), () => h.createWindow, () => addWindow({ ...form, start: "" })],
  ["editWindow", () => editWindow(UUID, form), () => h.updateWindow, () => editWindow("nope", form)],
  ["removeWindow", () => removeWindow(UUID), () => h.deleteWindow, () => removeWindow("nope")],
] as const;

beforeEach(() => {
  // Before the form's 13 Oct 22:00 WIB start, so that one-off window is still ahead.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-12T12:00:00Z") });
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(member);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  for (const fn of [h.createWindow, h.updateWindow, h.deleteWindow]) fn.mockResolvedValue({ ok: true, message: "Done.", audit });
  h.recordAction.mockResolvedValue(undefined);
});

afterEach(() => { vi.useRealTimers(); });

describe.each(all)("%s", (_name, call, target, bad) => {
  it("needs an operator: a viewer is refused before any limit or database call", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await call()).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("operator");
    expect(h.limit).not.toHaveBeenCalled();
    expect(target()).not.toHaveBeenCalled();
  });
  it("rejects bad input before the limit and the database", async () => {
    expect(await bad()).toMatchObject({ ok: false });
    expect(h.limit).not.toHaveBeenCalled();
    expect(target()).not.toHaveBeenCalled();
  });
  it("is limited like the other console writes", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 90 });
    expect(await call()).toEqual({ ok: false, error: "Too many changes. Try again in 2 minutes." });
    expect(h.limit).toHaveBeenCalledWith(LIMITS.monitorWrite, "mem-1");
    expect(target()).not.toHaveBeenCalled();
  });
  it("refreshes and records who did it on success only", async () => {
    expect(await call()).toEqual({ ok: true, message: "Done." });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", ...audit, actorUserId: "user-1" });
    target().mockResolvedValue({ ok: false, error: "No." });
    h.refresh.mockClear();
    expect(await call()).toEqual({ ok: false, error: "No." });
    expect(h.refresh).not.toHaveBeenCalled();
  });
  it("keeps working when the audit entry can't be written", async () => {
    h.recordAction.mockRejectedValue(new Error("db down"));
    expect(await call()).toMatchObject({ ok: true });
  });
});

describe("form actions", () => {
  it("reject a one-off window that has already ended, before the limit (review M4)", async () => {
    const past = { ...form, start: "2026-01-05T10:00", weekly: false };
    const ended = { ok: false, error: "Check the highlighted fields.", fieldErrors: { start: "That window has already ended." } };
    expect(await addWindow(past)).toEqual(ended);
    expect(await editWindow(UUID, past)).toEqual(ended);
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.createWindow).not.toHaveBeenCalled();
    expect(h.updateWindow).not.toHaveBeenCalled();
  });
  it("accept a weekly window that started in the past, since it repeats", async () => {
    expect(await addWindow({ ...form, start: "2026-01-05T10:00", weekly: true })).toMatchObject({ ok: true });
  });
  it("answer field errors for a bad form", async () => {
    expect(await addWindow({ ...form, start: "", durationMin: "2" })).toEqual({
      ok: false, error: "Check the highlighted fields.", fieldErrors: { start: "Pick a start time.", durationMin: "Pick how long it lasts." },
    });
  });
  it("hand the parsed values (WIB start read as UTC) and the member to the database", async () => {
    await addWindow(form);
    expect(h.createWindow).toHaveBeenCalledWith(parsed, "user-1");
    await editWindow(UUID, form);
    expect(h.updateWindow).toHaveBeenCalledWith(UUID, parsed);
  });
  it("reject a form that isn't an object", async () => {
    expect(await addWindow(null as never)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(h.createWindow).not.toHaveBeenCalled();
  });
});
