import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const M1 = "6f0d4c1e-7c55-4a0b-9d2e-1a2b3c4d5e6f";
const member = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };

const h = vi.hoisted(() => ({
  requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), revalidatePath: vi.fn(), recordAction: vi.fn(), saveStatusPage: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh, revalidatePath: h.revalidatePath }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/data/public-status-db", () => ({ saveStatusPage: h.saveStatusPage }));

import { LIMITS } from "@/lib/rate-limit";
import { saveStatusPageSettings } from "./status-page-actions";

const form = { slug: "acme", title: "Acme' apps", announcement: "", published: true, monitors: [{ monitorId: M1, displayName: "Portfolio" }] };
const audit = { message: "Status page saved: /s/acme (published, 1 monitor)", resourceId: null };

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(member);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.saveStatusPage.mockResolvedValue({ ok: true, oldSlug: null, message: "Status page saved. It updates within a minute.", audit });
  h.recordAction.mockResolvedValue(undefined);
});

describe("saveStatusPageSettings", () => {
  it("needs the owner: anyone else is refused before any limit or database call", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await saveStatusPageSettings(form)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.saveStatusPage).not.toHaveBeenCalled();
  });

  it("rejects bad input before the limit and the database", async () => {
    expect(await saveStatusPageSettings({ ...form, slug: "X" })).toEqual({
      ok: false, error: "Check the highlighted fields.", fieldErrors: { slug: "Use 3–40 lowercase letters, digits or dashes." },
    });
    expect(await saveStatusPageSettings(null as never)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.saveStatusPage).not.toHaveBeenCalled();
  });

  it("is limited like the other console writes", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 90 });
    expect(await saveStatusPageSettings(form)).toEqual({ ok: false, error: "Too many changes. Try again in 2 minutes." });
    expect(h.limit).toHaveBeenCalledWith(LIMITS.monitorWrite, "mem-1");
    expect(h.saveStatusPage).not.toHaveBeenCalled();
  });

  it("saves the parsed page, records who did it and refreshes the public page at once", async () => {
    expect(await saveStatusPageSettings(form)).toEqual({ ok: true, message: "Status page saved. It updates within a minute." });
    expect(h.saveStatusPage).toHaveBeenCalledWith({
      slug: "acme", title: "Acme' apps", announcement: null, published: true, monitors: [{ monitorId: M1, displayName: "Portfolio", position: 0 }],
    });
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", ...audit, actorUserId: "user-1" });
    expect(h.revalidatePath.mock.calls).toEqual([["/s/acme"]]);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("also refreshes the old address when the slug changed, so it stops answering", async () => {
    h.saveStatusPage.mockResolvedValue({ ok: true, oldSlug: "old-name", message: "Saved.", audit });
    await saveStatusPageSettings(form);
    expect(h.revalidatePath.mock.calls).toEqual([["/s/acme"], ["/s/old-name"]]);
  });

  it("passes a refusal on without refreshing or auditing", async () => {
    h.saveStatusPage.mockResolvedValue({ ok: false, error: "A monitor on the list no longer exists. Reload and try again." });
    expect(await saveStatusPageSettings(form)).toEqual({ ok: false, error: "A monitor on the list no longer exists. Reload and try again." });
    expect(h.recordAction).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("keeps working when the audit entry can't be written", async () => {
    h.recordAction.mockRejectedValue(new Error("db down"));
    expect(await saveStatusPageSettings(form)).toMatchObject({ ok: true });
    expect(h.revalidatePath).toHaveBeenCalled();
  });
});
