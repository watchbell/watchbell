import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";
import type { Proposal } from "./proposals-types";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const owner = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };

const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), decideAndRun: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => { void fn(); } }));
vi.mock("./proposals-decide", () => ({ decideAndRun: h.decideAndRun }));

import { decideProposalAction, decideProposalForm } from "./page-actions";

const proposal = (o: Partial<Proposal> = {}): Proposal => ({
  id: UUID, room: "workloads", action: "recheck", actionLabel: "Check again now", risk: "safe", title: "Check app-a again now", reason: "app-a /. Down.",
  resourceName: "app-a", proposedBy: "Workloads officer", status: "done", auto: false, result: "Checked: up (200).", createdAt: "2026-10-18T01:00:00.000Z",
  decidedAt: "2026-10-18T01:05:00.000Z", expiresAt: "2026-10-18T03:00:00.000Z", ...o,
});
const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(owner);
});

describe("decideProposalAction (owner only)", () => {
  it("refuses an operator before deciding anything", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    const r = await decideProposalAction(UUID, "approve");
    expect(r).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.decideAndRun).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("rejects a malformed id or decision before the database", async () => {
    expect(await decideProposalAction("nope", "approve")).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(await decideProposalAction(UUID, "maybe" as never)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(h.decideAndRun).not.toHaveBeenCalled();
  });

  it("approves through the shared decide path with this owner, returns the run's message and refreshes", async () => {
    h.decideAndRun.mockResolvedValue({ status: "ok", proposal: proposal() });
    const r = await decideProposalAction(UUID, "approve");
    expect(r).toEqual({ ok: true, message: "Checked: up (200)." });
    expect(h.decideAndRun).toHaveBeenCalledWith(UUID, "approve", { id: "mem-1", userId: "user-1" }, expect.any(Date));
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it("reports a failed run as an error with its result sentence", async () => {
    h.decideAndRun.mockResolvedValue({ status: "ok", proposal: proposal({ status: "failed", result: "Vercel said no." }) });
    expect(await decideProposalAction(UUID, "approve")).toEqual({ ok: false, error: "Vercel said no." });
  });

  it("rejects", async () => {
    h.decideAndRun.mockResolvedValue({ status: "ok", proposal: proposal({ status: "rejected", result: null }) });
    expect(await decideProposalAction(UUID, "reject")).toEqual({ ok: true, message: "Rejected." });
    expect(h.decideAndRun).toHaveBeenCalledWith(UUID, "reject", { id: "mem-1", userId: "user-1" }, expect.any(Date));
  });

  it("says when it was already decided (Telegram, another tab) or has expired, and refreshes to show it", async () => {
    h.decideAndRun.mockResolvedValue({ status: "conflict", proposal: proposal({ status: "approved" }) });
    const r = await decideProposalAction(UUID, "approve");
    expect(r).toEqual({ ok: false, error: "This proposal is already approved." });
    expect(r.ok ? "" : r.error).toContain("already");
    expect(h.refresh).toHaveBeenCalledOnce();
    h.decideAndRun.mockResolvedValue({ status: "conflict", proposal: proposal({ status: "pending" }) });
    expect(await decideProposalAction(UUID, "reject")).toEqual({ ok: false, error: "This proposal has expired." });
  });

  it("an unknown id", async () => {
    h.decideAndRun.mockResolvedValue({ status: "missing" });
    expect(await decideProposalAction(UUID, "approve")).toEqual({ ok: false, error: "Unknown proposal." });
  });

  it("a failure mid-decision tells the owner to check History (no retry) and refreshes", async () => {
    h.decideAndRun.mockRejectedValue(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await decideProposalAction(UUID, "approve")).toEqual({ ok: false, error: "The console couldn't confirm what happened. The proposal may already be approved or running, so check History before doing anything else." });
    expect(h.refresh).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("decideProposalForm (the page's Approve / Reject form)", () => {
  it("reads the id and the pressed button's decision", async () => {
    h.decideAndRun.mockResolvedValue({ status: "ok", proposal: proposal({ status: "rejected", result: null }) });
    expect(await decideProposalForm(null, form({ id: UUID, decision: "reject" }))).toEqual({ ok: true, message: "Rejected." });
    expect(h.decideAndRun).toHaveBeenCalledWith(UUID, "reject", { id: "mem-1", userId: "user-1" }, expect.any(Date));
  });

  it("a missing field is not valid", async () => {
    expect(await decideProposalForm(null, form({ id: UUID }))).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(h.decideAndRun).not.toHaveBeenCalled();
  });
});
