import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const member = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), recordAction: vi.fn(), readNotifyLangSetting: vi.fn(), saveNotifyLangs: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/data/settings-db", () => ({ readNotifyLangSetting: h.readNotifyLangSetting, saveNotifyLangs: h.saveNotifyLangs }));
vi.mock("@/lib/data/notify-db", () => ({}));
vi.mock("@/lib/data/telegram-bot-db", () => ({}));

import { setNotifyLanguage } from "./channel-actions";

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(member);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.recordAction.mockResolvedValue(undefined);
  h.readNotifyLangSetting.mockResolvedValue({ telegram: "id", discord: "en", email: "en" });
  h.saveNotifyLangs.mockResolvedValue(undefined);
});

describe("setNotifyLanguage", () => {
  it("refuses an operator before reading or writing", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await setNotifyLanguage("discord", "id")).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember.mock.calls[0][0]).toBe("owner");
    expect(h.saveNotifyLangs).not.toHaveBeenCalled();
  });
  it("refuses an invalid channel or value", async () => {
    for (const [c, v] of [["sms", "id"], ["", "id"], ["discord", "fr"], ["discord", ""], ["discord", "ID"], ["email_digest", "id"], [null, "id"], ["discord", null]]) {
      expect((await setNotifyLanguage(c as string, v as string)).ok).toBe(false);
    }
    expect(h.saveNotifyLangs).not.toHaveBeenCalled();
  });
  it("saves one channel, keeps the others, and audits it", async () => {
    const r = await setNotifyLanguage("discord", "id");
    expect(r.ok).toBe(true);
    expect(h.saveNotifyLangs).toHaveBeenCalledWith({ telegram: "id", discord: "id", email: "en" });
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "ok", message: "Settings: Discord language en → id", actorUserId: "user-1" }));
    expect(h.refresh).toHaveBeenCalled();
  });
  it("audits the email digest as email and Telegram by name", async () => {
    await setNotifyLanguage("telegram", "en");
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ message: "Settings: Telegram language id → en" }));
    expect(h.saveNotifyLangs).toHaveBeenCalledWith({ telegram: "en", discord: "en", email: "en" });
  });
  it("does nothing when that channel's language is unchanged", async () => {
    const r = await setNotifyLanguage("telegram", "id");
    expect(r).toEqual({ ok: true, message: "Nothing changed." });
    expect(h.saveNotifyLangs).not.toHaveBeenCalled();
    expect(h.recordAction).not.toHaveBeenCalled();
  });
  it("saves nothing, audits nothing and fails when the current languages can't be read", async () => {
    h.readNotifyLangSetting.mockRejectedValue(new Error("db down"));
    const r = await setNotifyLanguage("discord", "id");
    expect(r.ok).toBe(false);
    expect(h.saveNotifyLangs).not.toHaveBeenCalled();
    expect(h.recordAction).not.toHaveBeenCalled();
  });
});
