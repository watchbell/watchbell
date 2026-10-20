import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIONS_COPY } from "@/lib/copy/edition";
import { AuthError } from "@/lib/action";

const owner = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), limit: vi.fn(), revalidatePath: vi.fn(), write: vi.fn(), audit: vi.fn(), stored: null as unknown }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.audit }));
// The real writeAutoRun on a fake settings row.
vi.mock("@/db/client", () => ({
  db: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (h.stored ? [{ value: h.stored }] : []) }) }) }),
    insert: () => ({ values: (v: { value: unknown }) => ({ onConflictDoUpdate: async () => { h.stored = v.value; h.write(v.value); } }) }),
  }),
}));

import { saveOfficeAutoRun } from "./auto-run-actions";
import { AUTO_RUN_OFF } from "./proposals-settings";

beforeEach(() => {
  vi.clearAllMocks();
  h.stored = null;
  h.requireActionMember.mockResolvedValue(owner);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.audit.mockResolvedValue(undefined);
});

describe("saveOfficeAutoRun", () => {
  it("is Owner only", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await saveOfficeAutoRun({ recheck: true })).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.write).not.toHaveBeenCalled();
  });

  it("switches a safe kind on, saves and audits it", async () => {
    const r = await saveOfficeAutoRun({ recheck: true });
    expect(r).toEqual({ ok: true, message: "Check again now: auto-run on.", data: { ...AUTO_RUN_OFF, recheck: true } });
    expect(h.stored).toEqual({ ...AUTO_RUN_OFF, recheck: true });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ message: ACTIONS_COPY.settingsAudit.autoRun, actorUserId: "user-1" }));
    expect(h.revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("a crafted request: unknown kind or non-boolean refused; a risky kind stays off", async () => {
    expect(await saveOfficeAutoRun({ nope: true } as never)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(await saveOfficeAutoRun({ recheck: "on" } as never)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(await saveOfficeAutoRun(null as never)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    const r = await saveOfficeAutoRun({ vercel_redeploy: true });
    expect(r).toMatchObject({ ok: true, data: AUTO_RUN_OFF });
    expect(h.write).not.toHaveBeenCalled();
  });

  it("rate limited", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 120 });
    expect(await saveOfficeAutoRun({ recheck: true })).toMatchObject({ ok: false });
    expect(h.write).not.toHaveBeenCalled();
  });
});
