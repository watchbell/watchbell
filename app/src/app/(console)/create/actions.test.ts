import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

// Stage 6 create requests: approving and rejecting need the Owner with an aal2 session; asking is Owner-only (spec
// default). The flow itself is tested in lib/create/flow.test.ts.
const h = vi.hoisted(() => ({
  requireActionMember: vi.fn(), getSessionUser: vi.fn(), approve: vi.fn(), reject: vi.fn(), request: vi.fn(), cookies: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember, getSessionUser: h.getSessionUser }));
vi.mock("@/lib/create/flow", () => ({ approveCreate: h.approve, rejectCreate: h.reject, requestCreate: h.request }));
vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: h.cookies }));
vi.mock("@/lib/data/create-db", () => ({ claimRequest: vi.fn(), decideRequest: vi.fn(), finishRequest: vi.fn(), getRequest: vi.fn(), insertRequest: vi.fn(), removeCreateGrant: vi.fn() }));
vi.mock("@/lib/data/create-exec", () => ({ EXECUTORS: {} }));
vi.mock("@/lib/data/create-notify", () => ({ notifyCreateRequest: vi.fn() }));
vi.mock("@/lib/data/create-options", () => ({ createOptions: vi.fn() }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: vi.fn(async () => undefined) }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: vi.fn(async () => ({ allowed: true, retryAfter: 0 })) }));

import { approveCreateAction, rejectCreateAction, requestCreateAction } from "./actions";

const owner = { id: "m1", userId: "u1", email: "o@example.com", role: "owner" as const };
beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(owner);
  h.getSessionUser.mockResolvedValue({ userId: "u1", email: "o@example.com", aal: "aal2" });
  h.approve.mockResolvedValue({ ok: true, message: "Created." });
  h.reject.mockResolvedValue({ ok: true, message: "Rejected." });
  h.request.mockResolvedValue({ ok: true, message: "Asked." });
});

describe("create actions", () => {
  it("approve and reject need owner + aal2", async () => {
    h.getSessionUser.mockResolvedValue({ userId: "u1", email: "o@example.com", aal: "aal1" });
    expect(await approveCreateAction("id", "x")).toEqual({ ok: false, error: "Confirm your sign-in with your authenticator code first." });
    expect(await rejectCreateAction("id")).toMatchObject({ ok: false });
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.reject).not.toHaveBeenCalled();
    h.getSessionUser.mockResolvedValue({ userId: "u1", email: "o@example.com", aal: "aal2" });
    expect(await approveCreateAction("id", "x")).toEqual({ ok: true, message: "Created." });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
  });
  it("an operator can't approve, reject or ask", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    for (const r of [await approveCreateAction("id", "x"), await rejectCreateAction("id"), await requestCreateAction("dns_record", "z", {})]) {
      expect(r).toEqual({ ok: false, error: "You don't have permission to do that." });
    }
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });
});
