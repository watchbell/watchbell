import { beforeEach, describe, expect, it, vi } from "vitest";
import { USAGE_COPY } from "@/lib/copy/edition";
import { AuthError } from "@/lib/action";

const owner = { id: "mem-1", userId: "user-1", email: "o@example.com", role: "owner" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), recordAction: vi.fn(), saveLimits: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/private/ai/agent-usage-db", () => ({ saveLimits: h.saveLimits }));

import { saveAgLimits } from "./actions";

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(owner);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.saveLimits.mockResolvedValue(undefined);
});

describe("saveAgLimits", () => {
  it("saves the four limits (blank = none), audits and refreshes", async () => {
    const r = await saveAgLimits(form({ gemini5h: "1,000,000", geminiWeek: "", claude5h: "250000", claudeWeek: " " }));
    expect(r).toEqual({ ok: true, message: "Quota estimates saved." });
    expect(h.saveLimits).toHaveBeenCalledWith({ gemini5h: 1_000_000, geminiWeek: null, claude5h: 250_000, claudeWeek: null }, expect.any(Date));
    expect(h.limit).toHaveBeenCalledWith({ name: "monitor-write", max: 60, windowSeconds: 600 }, "mem-1");
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ message: USAGE_COPY.limitsAudit, actorUserId: "user-1" }));
    expect(h.refresh).toHaveBeenCalled();
  });
  it("refuses a bad number and saves nothing", async () => {
    expect(await saveAgLimits(form({ gemini5h: "lots" }))).toEqual({ ok: false, error: "Gemini · 5 h: enter a whole number of tokens, or leave it blank." });
    expect(await saveAgLimits(form({ claudeWeek: "0" }))).toMatchObject({ ok: false });
    expect(h.saveLimits).not.toHaveBeenCalled();
  });
  it("is owner only and rate-limited", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect((await saveAgLimits(form({}))).ok).toBe(false);
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    h.requireActionMember.mockResolvedValue(owner);
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 120 });
    expect((await saveAgLimits(form({}))).ok).toBe(false);
    expect(h.saveLimits).not.toHaveBeenCalled();
  });
});
