import { describe, expect, it, vi } from "vitest";
import { type RunDeps, runProposalAction } from "./proposals-run";

const APP = "123e4567-e89b-42d3-a456-426614174000";
const REPO = "323e4567-e89b-42d3-a456-426614174000";
const owner = { id: "m1", userId: "u1" };

const deps = (bumpPrAs: unknown): RunDeps => ({
  checkMonitorNow: vi.fn(), keepAliveNow: vi.fn(), wakeAs: vi.fn(), supabaseAct: vi.fn(), redeployAs: vi.fn(), rollbackAs: vi.fn(),
  finish: vi.fn().mockResolvedValue({ ok: true }), recordAction: vi.fn(), limit: vi.fn(), bumpPrAs,
}) as unknown as RunDeps;

describe("runProposalAction: github_bump_pr (Stage 9 slice 5)", () => {
  it("calls the PR core with the approving owner, the app and its repository, and a no-refresh finisher", async () => {
    const bump = vi.fn().mockResolvedValue({ ok: true, message: "Pull request #12 opened." });
    const d = deps(bump);
    expect(await runProposalAction({ action: "github_bump_pr", resourceId: APP, targetRef: REPO }, owner, d)).toEqual({ ok: true, message: "Pull request #12 opened." });
    const call = bump.mock.calls[0];
    expect(call.slice(0, 3)).toEqual([{ id: "m1", userId: "u1" }, APP, REPO]);
    await call[3]({ done: false, message: "x" }, call[0], "acc");
    expect(d.finish).toHaveBeenCalledWith({ done: false, message: "x" }, call[0], "acc", { refresh: false });
  });

  it("without the write token the run fails with the core's clear sentence", async () => {
    const d = deps(vi.fn().mockResolvedValue({ ok: false, error: "A GitHub PR-write token is needed: connect \"GitHub (PR write)\" on Connections." }));
    expect(await runProposalAction({ action: "github_bump_pr", resourceId: APP, targetRef: REPO }, owner, d)).toMatchObject({ ok: false, error: expect.stringContaining("PR-write token is needed") });
  });

  it("a missing target fails before the core runs", async () => {
    const bump = vi.fn();
    expect((await runProposalAction({ action: "github_bump_pr", resourceId: APP, targetRef: null }, owner, deps(bump))).ok).toBe(false);
    expect(bump).not.toHaveBeenCalled();
  });
});
