import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const REF = "abcdefghijklmnopqrst";
const KEY = "sb_secret" + "_FAKE_test_key_not_real_0000";
const owner = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };

const h = vi.hoisted(() => ({
  requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), recordAction: vi.fn(), save: vi.fn(), remove: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/data/supabase-metrics-db", () => ({ saveMetricsKey: h.save, removeMetricsKey: h.remove }));

import { LIMITS } from "@/lib/rate-limit";
import { deleteMetricsKey, setMetricsKey } from "./metrics-actions";

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(owner);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.save.mockResolvedValue({ ok: true, message: "Metrics key saved for quillpad.", audit: { message: "Metrics key saved · quillpad", resourceId: UUID } });
  h.remove.mockResolvedValue({ ok: true, message: "Metrics key removed for quillpad.", audit: { message: "Metrics key removed · quillpad", resourceId: UUID } });
});

describe("setMetricsKey", () => {
  it("is owner only: an operator is refused before any quota or write", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await setMetricsKey(UUID, REF, KEY)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it("rejects a malformed id, ref or key before the quota", async () => {
    for (const [id, ref, key] of [["nope", REF, KEY], [UUID, "../x", KEY], [UUID, REF, 42 as unknown as string]] as const) {
      expect(await setMetricsKey(id, ref, key)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    }
    expect(await setMetricsKey(UUID, REF, "sb_publishable_abcdefghijk")).toMatchObject({ ok: false, fieldErrors: { key: expect.stringContaining("sb_secret_") } });
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it("uses the console-row write quota", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 120 });
    expect(await setMetricsKey(UUID, REF, KEY)).toMatchObject({ ok: false, error: expect.stringContaining("Too many changes") });
    expect(h.limit).toHaveBeenCalledWith(LIMITS.monitorWrite, "mem-1");
    expect(h.save).not.toHaveBeenCalled();
  });

  it("saves the trimmed key, audits without it and refreshes", async () => {
    expect(await setMetricsKey(UUID, REF, `  ${KEY}\n`)).toEqual({ ok: true, message: "Metrics key saved for quillpad." });
    expect(h.save).toHaveBeenCalledWith(UUID, REF, KEY, "user-1");
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "Metrics key saved · quillpad", resourceId: UUID, actorUserId: "user-1" });
    expect(JSON.stringify(h.recordAction.mock.calls)).not.toContain(KEY);
    expect(h.refresh).toHaveBeenCalled();
  });

  it("passes a refusal through without auditing", async () => {
    h.save.mockResolvedValue({ ok: false, error: "Supabase rejected the metrics key (401). Replace it with a current Secret API key." });
    expect(await setMetricsKey(UUID, REF, KEY)).toEqual({ ok: false, error: "Supabase rejected the metrics key (401). Replace it with a current Secret API key." });
    expect(h.recordAction).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });
});

describe("deleteMetricsKey", () => {
  it("is owner only and checks the id", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await deleteMetricsKey(UUID)).toMatchObject({ ok: false });
    expect(h.remove).not.toHaveBeenCalled();
    h.requireActionMember.mockResolvedValue(owner);
    expect(await deleteMetricsKey("x")).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(h.remove).not.toHaveBeenCalled();
  });

  it("removes and audits", async () => {
    expect(await deleteMetricsKey(UUID)).toEqual({ ok: true, message: "Metrics key removed for quillpad." });
    expect(h.remove).toHaveBeenCalledWith(UUID);
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "Metrics key removed · quillpad", resourceId: UUID, actorUserId: "user-1" });
  });
});
