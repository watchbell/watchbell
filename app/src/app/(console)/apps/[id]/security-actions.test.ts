import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const member = { id: "mem-1", userId: "user-1", email: "op@example.com", role: "operator" as const };

const h = vi.hoisted(() => ({
  requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), recordAction: vi.fn(), checkSecurityNow: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/data/security-db", () => ({ checkSecurityNow: h.checkSecurityNow }));

import { LIMITS } from "@/lib/rate-limit";
import { checkSecurity } from "./security-actions";

const audit = { message: "Security check: nova-wallet", resourceId: UUID };

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.requireActionMember.mockResolvedValue(member);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.checkSecurityNow.mockResolvedValue({ ok: true, message: "No known vulnerabilities for Next.js 16.4.0.", passed: true, vulnerable: false, audit });
});

describe("checkSecurity", () => {
  it("needs an Operator or Owner", async () => {
    await checkSecurity(UUID);
    expect(h.requireActionMember).toHaveBeenCalledWith("operator");
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await checkSecurity(UUID)).toEqual({ ok: false, error: "You don't have permission to do that." });
  });

  it("rejects a non-UUID before the rate limit or any request", async () => {
    expect(await checkSecurity("nope")).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.checkSecurityNow).not.toHaveBeenCalled();
  });

  it("is limited to 10 in 10 minutes per member, before it fetches anything", async () => {
    expect(LIMITS.securityCheck).toEqual({ name: "security-check", max: 10, windowSeconds: 600 });
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 90 });
    expect(await checkSecurity(UUID)).toEqual({ ok: false, error: "Too many security checks. Try again in 2 minutes." });
    expect(h.limit).toHaveBeenCalledWith(LIMITS.securityCheck, "mem-1");
    expect(h.checkSecurityNow).not.toHaveBeenCalled();
  });

  it("runs the check, audits it with the acting user, and refreshes the page", async () => {
    expect(await checkSecurity(UUID)).toEqual({ ok: true, message: "No known vulnerabilities for Next.js 16.4.0.", data: { passed: true, vulnerable: false } });
    expect(h.checkSecurityNow).toHaveBeenCalledWith(UUID);
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", ...audit, actorUserId: "user-1" });
    expect(h.refresh).toHaveBeenCalled();
  });

  it("records a failed check as an error entry and passes passed: false on", async () => {
    h.checkSecurityNow.mockResolvedValue({ ok: true, message: "The check failed: OSV.dev answered HTTP 503.", passed: false, vulnerable: true, audit });
    expect(await checkSecurity(UUID)).toMatchObject({ ok: true, data: { passed: false, vulnerable: true } });
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "err", actorUserId: "user-1" }));
  });

  it("still answers when the audit entry can't be written", async () => {
    h.recordAction.mockRejectedValue(new Error("db down"));
    expect(await checkSecurity(UUID)).toMatchObject({ ok: true });
  });

  it("returns the error when the app is gone, without an audit entry", async () => {
    h.checkSecurityNow.mockResolvedValue({ ok: false, error: "That app is no longer in the console." });
    expect(await checkSecurity(UUID)).toEqual({ ok: false, error: "That app is no longer in the console." });
    expect(h.recordAction).not.toHaveBeenCalled();
  });
});
