import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const APP = "223e4567-e89b-42d3-a456-426614174000";
const member = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };

const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), recordAction: vi.fn(), dismiss: vi.fn(), dismissMany: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("./notes-view", async (orig) => ({ ...(await orig<typeof import("./notes-view")>()), dismiss: h.dismiss, dismissMany: h.dismissMany }));

import { LIMITS } from "@/lib/rate-limit";
import { dismissAllNotes, dismissNote } from "./notes-actions";

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(member);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.dismiss.mockResolvedValue({ id: ID, title: "orbit-blog: down", appId: APP, from: "antigravity/1.4" });
  h.recordAction.mockResolvedValue(undefined);
});

describe("dismissNote (owner only, audited)", () => {
  it("denies a non-owner before any limit or write", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await dismissNote(ID)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.dismiss).not.toHaveBeenCalled();
  });
  it("rejects a malformed id", async () => {
    expect(await dismissNote("x' or 1=1")).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(h.limit).not.toHaveBeenCalled();
  });
  it("is rate limited per member", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 300 });
    expect(await dismissNote(ID)).toEqual({ ok: false, error: "Too many changes. Try again in 5 minutes." });
    expect(h.limit).toHaveBeenCalledWith(LIMITS.monitorWrite, "mem-1");
    expect(h.dismiss).not.toHaveBeenCalled();
  });
  it("dismisses, audits (AiNoteDismissed) and refreshes", async () => {
    expect(await dismissNote(ID)).toEqual({ ok: true, message: "Note dismissed." });
    expect(h.dismiss).toHaveBeenCalledWith(ID, "user-1", expect.any(Date));
    expect(h.recordAction).toHaveBeenCalledWith({
      kind: "ok", message: "AI note dismissed: orbit-blog: down", detail: "AiNoteDismissed · from antigravity/1.4", resourceId: APP, actorUserId: "user-1",
    });
    expect(h.refresh).toHaveBeenCalledOnce();
  });
  it("audits a console-wide note (or a name stored as app) without a resource id", async () => {
    h.dismiss.mockResolvedValue({ id: ID, title: "T", appId: "orbit-blog", from: "antigravity" });
    await dismissNote(ID);
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ resourceId: null }));
  });
  it("reports a note that is gone or already dismissed", async () => {
    h.dismiss.mockResolvedValue(null);
    expect(await dismissNote(ID)).toEqual({ ok: false, error: "That note was already dismissed." });
    expect(h.recordAction).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });
  it("an audit failure doesn't undo the dismissal", async () => {
    h.recordAction.mockRejectedValue(new Error("db"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await dismissNote(ID)).ok).toBe(true);
  });
});

describe("dismissAllNotes (owner only, one audit event)", () => {
  const IDS = [ID, APP];
  beforeEach(() => { h.dismissMany.mockResolvedValue(2); });
  it("denies a non-owner before any limit or write", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await dismissAllNotes(IDS)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.dismissMany).not.toHaveBeenCalled();
  });
  it("rejects an empty list, a malformed id or more than the card shows", async () => {
    for (const bad of [[], [ID, "x' or 1=1"], Array.from({ length: 21 }, () => ID)]) {
      expect(await dismissAllNotes(bad)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    }
    expect(h.limit).not.toHaveBeenCalled();
  });
  it("is rate limited once per click", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 300 });
    expect(await dismissAllNotes(IDS)).toEqual({ ok: false, error: "Too many changes. Try again in 5 minutes." });
    expect(h.limit).toHaveBeenCalledOnce();
    expect(h.dismissMany).not.toHaveBeenCalled();
  });
  it("dismisses every id (duplicates once), audits once and refreshes", async () => {
    expect(await dismissAllNotes([...IDS, ID])).toEqual({ ok: true, message: "2 notes dismissed." });
    expect(h.dismissMany).toHaveBeenCalledWith(IDS, "user-1", expect.any(Date));
    expect(h.recordAction).toHaveBeenCalledOnce();
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "2 AI notes dismissed", detail: "AiNotesDismissed", resourceId: null, actorUserId: "user-1" });
    expect(h.refresh).toHaveBeenCalledOnce();
  });
  it("reports notes that were all dismissed already", async () => {
    h.dismissMany.mockResolvedValue(0);
    expect(await dismissAllNotes(IDS)).toEqual({ ok: false, error: "Those notes were already dismissed." });
    expect(h.recordAction).not.toHaveBeenCalled();
  });
});
