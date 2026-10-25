import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ fail: vi.fn(), wait: vi.fn(), clear: vi.fn(), alert: vi.fn() }));
vi.mock("@/lib/backoff-db", () => ({ backoffFail: h.fail, backoffWait: h.wait, backoffClear: h.clear }));
vi.mock("@/lib/data/auth-alert", () => ({ notifyAuthFailures: h.alert }));
import { mfaFailed, mfaPassed, mfaWait } from "./mfa-backoff";

beforeEach(() => vi.clearAllMocks());

describe("MFA back-off (audit L6)", () => {
  it("counts a wrong code per user and alerts from the 10th of the day", async () => {
    h.fail.mockResolvedValueOnce(9).mockResolvedValueOnce(10);
    await mfaFailed("u1");
    expect(h.alert).not.toHaveBeenCalled();
    await mfaFailed("u1");
    expect(h.fail).toHaveBeenCalledWith("mfa-code-backoff", "u1");
    expect(h.alert).toHaveBeenCalledWith("mfa", "u1", 10);
  });
  it("reads the wait and starts over after a right code", async () => {
    h.wait.mockResolvedValue(60);
    expect(await mfaWait("u1")).toBe(60);
    await mfaPassed("u1");
    expect(h.clear).toHaveBeenCalledWith("mfa-code-backoff", "u1");
  });
});
