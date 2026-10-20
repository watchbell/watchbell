import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const member = { id: "mem-1", userId: "user-1", email: "op@example.com", role: "operator" as const };

const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), recordAction: vi.fn(), scanAppNow: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/data/deps-db", () => ({ scanAppNow: h.scanAppNow }));

import { LIMITS } from "@/lib/rate-limit";
import { scanDependencies } from "./deps-actions";

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.requireActionMember.mockResolvedValue(member);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.recordAction.mockResolvedValue(undefined);
  h.scanAppNow.mockResolvedValue({ ok: true, message: "1 known vulnerability in 312 packages.", app: "acme-shop", repo: "acme/acme-shop", vulns: 1 });
});

describe("scanDependencies (App page → Dependencies → Scan now)", () => {
  it("needs an Operator or Owner", async () => {
    await scanDependencies(UUID);
    expect(h.requireActionMember).toHaveBeenCalledWith("operator");
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await scanDependencies(UUID)).toEqual({ ok: false, error: "You don't have permission to do that." });
  });

  it("rejects a non-UUID before the rate limit or any scan", async () => {
    expect(await scanDependencies("nope")).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.scanAppNow).not.toHaveBeenCalled();
  });

  it("is limited to 5 in 10 minutes per member, before it scans", async () => {
    expect(LIMITS.depsScan).toEqual({ name: "deps-scan", max: 5, windowSeconds: 600 });
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 90 });
    expect(await scanDependencies(UUID)).toEqual({ ok: false, error: "Too many dependency scans. Try again in 2 minutes." });
    expect(h.limit).toHaveBeenCalledWith(LIMITS.depsScan, "mem-1");
    expect(h.scanAppNow).not.toHaveBeenCalled();
  });

  it("scans, audits with the acting user, refreshes the page", async () => {
    expect(await scanDependencies(UUID)).toEqual({ ok: true, message: "1 known vulnerability in 312 packages.", data: { vulns: 1 } });
    expect(h.scanAppNow).toHaveBeenCalledWith(UUID);
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "Dependency scan · acme-shop · 1 open", resourceId: UUID, actorUserId: "user-1" });
    expect(h.refresh).toHaveBeenCalled();
  });

  it("passes a failed scan's error on, without an audit entry", async () => {
    h.scanAppNow.mockResolvedValue({ ok: false, error: "Link a repository first." });
    expect(await scanDependencies(UUID)).toEqual({ ok: false, error: "Link a repository first." });
    expect(h.recordAction).not.toHaveBeenCalled();
  });
});
