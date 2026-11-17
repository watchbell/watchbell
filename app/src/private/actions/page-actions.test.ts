import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";
import type { Proposal } from "./proposals-types";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const owner = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };

const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), decideAndRun: vi.fn(), refresh: vi.fn(), askAgain: vi.fn(), notifyNew: vi.fn(), after: vi.fn(), telegramTarget: vi.fn(), recordAction: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("next/server", () => ({ after: h.after }));
vi.mock("@/lib/data/notify-db", () => ({ telegramTarget: h.telegramTarget }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("./proposals-decide", () => ({ decideAndRun: h.decideAndRun }));
vi.mock("./proposals-db", () => ({ askAgain: h.askAgain }));
vi.mock("./proposals-notify", () => ({ notifyNewProposals: h.notifyNew }));

import { askAgainAction, decideProposalAction, decideProposalForm } from "./page-actions";

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
  h.after.mockImplementation((fn: () => unknown) => { void fn(); });
  h.recordAction.mockResolvedValue(undefined);
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

// 1.8.2 (owner 17 Nov): Ask again on an expired proposal in History; a pending copy goes to Telegram like a new one.
describe("askAgainAction (owner only)", () => {
  const ALERT = "523e4567-e89b-42d3-a456-426614174000";
  const NEW = "923e4567-e89b-42d3-a456-426614174999";
  const copy = {
    id: NEW, room: "workloads", action: "github_bump_pr", risk: "safe", title: "Open a PR updating Next.js in app-o", reason: "r", resourceName: "app-o",
    proposedBy: "Workloads officer", status: "pending", auto: false, result: null, createdAt: new Date("2026-11-17T10:30:00Z"), decidedAt: null,
    expiresAt: new Date("2026-11-17T12:30:00Z"), resourceId: null, targetRef: null, alertId: ALERT,
  };

  it("refuses an operator before reading anything", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await askAgainAction(UUID)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.askAgain).not.toHaveBeenCalled();
  });

  it("refuses a malformed id", async () => {
    expect(await askAgainAction("nope")).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(h.askAgain).not.toHaveBeenCalled();
  });

  it("sends the new copy to Telegram once, as a reply to its alert, and refreshes the page", async () => {
    h.askAgain.mockResolvedValue({ status: "ok", row: copy });
    h.notifyNew.mockResolvedValue(undefined);
    h.telegramTarget.mockResolvedValue({ token: "t", chatId: "c" });
    const r = await askAgainAction(UUID);
    expect(r).toEqual({ ok: true, message: "Asked again. It waits for you here and on Telegram for 2 hours." });
    // 1.8.3 (final review 1.8.2 M5): the send runs after the answer, like Approve's history line.
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.askAgain).toHaveBeenCalledWith(UUID, expect.any(Date));
    expect(h.notifyNew).toHaveBeenCalledTimes(1);
    const [list, , opts] = h.notifyNew.mock.calls[0];
    expect(list).toEqual([expect.objectContaining({ id: NEW, status: "pending", action: "github_bump_pr" })]);
    expect(opts.alertIds).toEqual(new Map([[NEW, ALERT]]));
    expect(h.refresh).toHaveBeenCalled();
  });

  it("explains each refusal and sends nothing", async () => {
    for (const [status, error] of [
      ["not-expired", "Only an expired proposal can be asked again."],
      ["alert-resolved", "Its alert isn't firing any more, so there's nothing to ask."],
      ["already-waiting", "A copy of this proposal is already waiting for you."],
      ["superseded", "A newer copy of this proposal exists, so this one can't be asked again."],
      ["missing", "Unknown proposal."],
    ]) {
      h.askAgain.mockResolvedValue({ status });
      expect(await askAgainAction(UUID)).toEqual({ ok: false, error });
    }
    expect(h.notifyNew).not.toHaveBeenCalled();
  });
});

// 1.8.3 (final review 1.8.2, minors 4 and 7): the answer only promises Telegram when a chat is connected, the window
// comes from PROPOSAL_TTL_MS, and Events records who asked again.
describe("askAgainAction's answer and record (1.8.3)", () => {
  const copy = {
    id: "923e4567-e89b-42d3-a456-426614174999", room: "workloads", action: "github_bump_pr", risk: "safe", title: "Open a PR updating Next.js in app-o",
    reason: "r", resourceName: "app-o", proposedBy: "Workloads officer", status: "pending", auto: false, result: null, createdAt: new Date("2026-11-18T10:30:00Z"),
    decidedAt: null, expiresAt: new Date("2026-11-18T12:30:00Z"), resourceId: "623e4567-e89b-42d3-a456-426614174000", targetRef: null, alertId: "523e4567-e89b-42d3-a456-426614174000",
  };
  it("says only 'here' when no Telegram chat is connected", async () => {
    h.askAgain.mockResolvedValue({ status: "ok", row: copy });
    h.telegramTarget.mockResolvedValue(null);
    expect(await askAgainAction(UUID)).toEqual({ ok: true, message: "Asked again. It waits for you here for 2 hours." });
  });
  it("still answers when the Telegram setting can't be read", async () => {
    h.askAgain.mockResolvedValue({ status: "ok", row: copy });
    h.telegramTarget.mockRejectedValue(new Error("db"));
    expect(await askAgainAction(UUID)).toEqual({ ok: true, message: "Asked again. It waits for you here for 2 hours." });
  });
  it("records who asked again in Events", async () => {
    h.askAgain.mockResolvedValue({ status: "ok", row: copy });
    h.telegramTarget.mockResolvedValue(null);
    await askAgainAction(UUID);
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "Asked again: Open a PR updating Next.js in app-o", resourceId: copy.resourceId, actorUserId: "user-1" });
  });
});
