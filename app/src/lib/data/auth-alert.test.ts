import { describe, expect, it, vi } from "vitest";

vi.mock("@/db/client", () => ({ db: () => { throw new Error("no database in tests"); } }));
import { authFailureNotice, notifyAuthFailures } from "./auth-alert";

describe("notifyAuthFailures (audit L5/L6)", () => {
  const deps = (allowed = true) => ({
    allowed: vi.fn().mockResolvedValue(allowed), target: vi.fn().mockResolvedValue({ token: "t", chatId: "c" }), lang: vi.fn().mockResolvedValue("en" as const),
    send: vi.fn().mockResolvedValue({ ok: true }), record: vi.fn().mockResolvedValue(undefined),
  });
  it("sends one notice through the Telegram path, without the email", async () => {
    const d = deps();
    await notifyAuthFailures("password", "ana@example.com", 10, d);
    expect(d.allowed).toHaveBeenCalledWith("password", "ana@example.com");
    expect(d.send).toHaveBeenCalledWith("t", "c", authFailureNotice("password", 10));
    expect(JSON.stringify(d.send.mock.calls)).not.toContain("ana@");
  });
  it("sends nothing past the hourly limit or without Telegram; never throws", async () => {
    const d = deps(false);
    await notifyAuthFailures("mfa", "u1", 12, d);
    expect(d.send).not.toHaveBeenCalled();
    const e = { ...deps(), target: vi.fn().mockRejectedValue(new Error("db")) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(notifyAuthFailures("mfa", "u1", 12, e)).resolves.toBeUndefined();
    warn.mockRestore();
  });
  it("says it in Indonesian too", () => {
    expect(authFailureNotice("mfa", 10, "id")).toContain("kode authenticator yang salah");
    expect(authFailureNotice("password", 10)).toBe("⚠️ Watchbell: 10 wrong passwords for one account today. If that wasn't you, check who can reach the console.");
  });
});
