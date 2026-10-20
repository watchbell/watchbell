import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const APP = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const owner = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), linkAppRepo: vi.fn(), refreshAppActions: vi.fn(), recordAction: vi.fn(), limit: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/data/github-db", () => ({ linkAppRepo: h.linkAppRepo, refreshAppActions: h.refreshAppActions }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));

import { linkRepo, refreshRepoActions } from "./github-actions";

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.requireActionMember.mockResolvedValue(owner);
  h.recordAction.mockResolvedValue(undefined);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
});

describe("linkRepo (owner confirms, B7)", () => {
  it("is Owner only and validates ids", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await linkRepo(APP, REPO)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    h.requireActionMember.mockResolvedValue(owner);
    expect(await linkRepo("x", REPO)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(h.linkAppRepo).not.toHaveBeenCalled();
  });
  it("links, audits on the app, and refreshes the page", async () => {
    h.linkAppRepo.mockResolvedValue({ ok: true, message: "acme-shop is linked to acme/acme-shop.", app: "acme-shop", repo: "acme/acme-shop" });
    expect(await linkRepo(APP, REPO)).toEqual({ ok: true, message: "acme-shop is linked to acme/acme-shop." });
    expect(h.linkAppRepo).toHaveBeenCalledWith(APP, REPO, "user-1");
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "Repository linked · acme-shop → acme/acme-shop", resourceId: APP, actorUserId: "user-1" });
    expect(h.refresh).toHaveBeenCalled();
  });
  it("audits an unlink", async () => {
    h.linkAppRepo.mockResolvedValue({ ok: true, message: "acme-shop is no longer linked to a repository.", app: "acme-shop", repo: null });
    await linkRepo(APP, null);
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ message: "Repository unlinked · acme-shop" }));
  });
});

describe("refreshRepoActions", () => {
  it("is Operator and up, rate limited, and says the result in words", async () => {
    h.refreshAppActions.mockResolvedValue({ ok: true, repo: "acme/acme-shop", run: { status: "completed", conclusion: "failure", name: "CI", branch: "main", sha: null, url: null, at: null, runNumber: 3 } });
    expect(await refreshRepoActions(APP)).toEqual({ ok: true, message: "GitHub Actions: failing." });
    expect(h.requireActionMember).toHaveBeenCalledWith("operator");
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 120 });
    expect(await refreshRepoActions(APP)).toEqual({ ok: false, error: "Too many refreshes. Try again in 2 minutes." });
  });
});
