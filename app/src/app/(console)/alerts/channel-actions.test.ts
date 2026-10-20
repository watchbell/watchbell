import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_COPY } from "@/lib/copy/edition";
import { AuthError } from "@/lib/action";

const member = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };
const HOOK = "https://discord.com/api/web" + "hooks/123456789012345678/abcdefghijklmnopqrstuvwxyz-ABCDEF_0123";

const h = vi.hoisted(() => ({
  requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), recordAction: vi.fn(), writeChannel: vi.fn(), storeEnabled: vi.fn(), sendTestMessage: vi.fn(),
  notifyEnv: vi.fn(), findChats: vi.fn(), webhookOn: vi.fn(), readSeenChats: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/data/notify-db", () => ({ writeChannel: h.writeChannel, setChannelEnabled: h.storeEnabled, sendTest: h.sendTestMessage }));
vi.mock("@/lib/notify/env", () => ({ notifyEnv: h.notifyEnv }));
vi.mock("@/lib/notify/telegram", () => ({ findChats: h.findChats }));
vi.mock("@/lib/data/telegram-bot-db", () => ({ webhookOn: h.webhookOn, readSeenChats: h.readSeenChats }));

import { LIMITS } from "@/lib/rate-limit";
import { saveDigest, saveDiscord, saveTelegram, sendTest, setChannelEnabled, telegramChats } from "./channel-actions";

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(member);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.recordAction.mockResolvedValue(undefined);
  h.writeChannel.mockResolvedValue(undefined);
  h.webhookOn.mockResolvedValue(false);
  h.notifyEnv.mockReturnValue({ telegramToken: "123456:ABCdefGHIjklMNOpqrSTUvwxYZ", resendKey: "re_x", digestFrom: "Ops <a@b.co>" });
});

describe("owner only", () => {
  it("refuses an operator on every action before any limit or write", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    const forbidden = { ok: false, error: "You don't have permission to do that." };
    expect(await telegramChats()).toEqual(forbidden);
    expect(await saveTelegram("42", "Alex")).toEqual(forbidden);
    expect(await saveDiscord(HOOK)).toEqual(forbidden);
    expect(await saveDigest("me@example.com")).toEqual(forbidden);
    expect(await setChannelEnabled("telegram", false)).toEqual(forbidden);
    expect(await sendTest("telegram")).toEqual(forbidden);
    expect(h.requireActionMember.mock.calls.every((c) => c[0] === "owner")).toBe(true);
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.writeChannel).not.toHaveBeenCalled();
    expect(h.sendTestMessage).not.toHaveBeenCalled();
  });
});

describe("telegramChats", () => {
  it("says so when the bot token isn't set, without calling Telegram", async () => {
    h.notifyEnv.mockReturnValue({ telegramToken: null, resendKey: null, digestFrom: null });
    expect(await telegramChats()).toEqual({ ok: false, error: ENV_COPY.notSet("TELEGRAM_BOT_TOKEN") });
    expect(h.findChats).not.toHaveBeenCalled();
  });
  it("returns the chats, or Telegram's problem in words", async () => {
    h.findChats.mockResolvedValueOnce({ ok: true, chats: [{ id: "42", label: "Alex (private)" }] });
    expect(await telegramChats()).toMatchObject({ ok: true, data: { chats: [{ id: "42", label: "Alex (private)" }] } });
    h.findChats.mockResolvedValueOnce({ ok: false, error: "Couldn't reach Telegram. Try again." });
    expect(await telegramChats()).toEqual({ ok: false, error: "Couldn't reach Telegram. Try again." });
    expect(h.readSeenChats).not.toHaveBeenCalled();
  });
  it("while the approval buttons are on (webhook set): the chats the webhook has seen, no getUpdates (Stage 9 slice 7)", async () => {
    h.webhookOn.mockResolvedValue(true);
    h.readSeenChats.mockResolvedValueOnce([{ id: "-100777", label: "Ops (group)", at: "2026-10-16T03:00:00.000Z" }]);
    expect(await telegramChats()).toEqual({ ok: true, data: { chats: [{ id: "-100777", label: "Ops (group)" }] }, message: undefined });
    h.readSeenChats.mockResolvedValueOnce([]);
    expect(await telegramChats()).toMatchObject({ ok: true, data: { chats: [] }, message: expect.stringContaining("No chats seen since the approval buttons were turned on") });
    expect(h.findChats).not.toHaveBeenCalled();
  });
});

describe("saveTelegram", () => {
  it("rejects a chat id that isn't a number", async () => {
    expect(await saveTelegram("abc", "x")).toEqual({ ok: false, error: "Check the highlighted fields.", fieldErrors: { chat: "Press Find chats, then pick one." } });
    expect(h.writeChannel).not.toHaveBeenCalled();
  });
  it("stores the chat, audits without the id, and refreshes", async () => {
    const r = await saveTelegram("-1001234567", "Ops (group)");
    expect(r).toEqual({ ok: true, message: "Telegram saved. Send a test to check it." });
    expect(h.writeChannel).toHaveBeenCalledWith("telegram", { chatId: "-1001234567", chatLabel: "Ops (group)" });
    expect(JSON.stringify(h.recordAction.mock.calls)).not.toContain("1001234567");
    expect(h.refresh).toHaveBeenCalledOnce();
  });
});

describe("saveDiscord", () => {
  it("rejects anything but a Discord webhook URL", async () => {
    expect(await saveDiscord("https://evil.com/api/webhooks/1/x")).toEqual({ ok: false, error: "Check the highlighted fields.", fieldErrors: { url: "Paste the whole webhook URL from Discord." } });
    expect(h.writeChannel).not.toHaveBeenCalled();
  });
  it("stores the trimmed URL and never audits it", async () => {
    expect(await saveDiscord(`  ${HOOK} `)).toMatchObject({ ok: true });
    expect(h.writeChannel).toHaveBeenCalledWith("discord", { url: HOOK });
    expect(JSON.stringify(h.recordAction.mock.calls)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});

describe("saveDigest", () => {
  it("needs a valid address", async () => {
    expect(await saveDigest("not an email")).toEqual({ ok: false, error: "Check the highlighted fields.", fieldErrors: { to: "Enter a valid email address." } });
    expect(await saveDigest("me@example.com")).toMatchObject({ ok: true });
    expect(h.writeChannel).toHaveBeenCalledWith("email_digest", { to: "me@example.com" });
    expect(JSON.stringify(h.recordAction.mock.calls)).not.toContain("me@example.com");
  });
});

describe("setChannelEnabled", () => {
  it("turns a connected channel off, and says when there is none", async () => {
    h.storeEnabled.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await setChannelEnabled("discord", false)).toEqual({ ok: true, message: "Discord is off." });
    expect(await setChannelEnabled("discord", true)).toEqual({ ok: false, error: "Discord isn't connected yet." });
    expect(await setChannelEnabled("fax" as never, true)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
  });
});

describe("sendTest", () => {
  it("is limited to 5 tests per member per 10 minutes", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 300 });
    expect(await sendTest("telegram")).toEqual({ ok: false, error: "Too many changes. Try again in 5 minutes." });
    expect(h.limit).toHaveBeenCalledWith(LIMITS.notifyTest, "mem-1");
    expect(h.sendTestMessage).not.toHaveBeenCalled();
  });
  it("reports success per channel", async () => {
    h.sendTestMessage.mockResolvedValue({ ok: true });
    expect(await sendTest("telegram")).toEqual({ ok: true, message: "Test message sent to Telegram." });
    expect(await sendTest("email_digest")).toEqual({ ok: true, message: "Test digest sent. It arrives within a minute." });
  });
  it("returns the channel's own error text", async () => {
    h.sendTestMessage.mockResolvedValue({ ok: false, kind: "config", error: "Telegram: Bad Request: chat not found" });
    expect(await sendTest("telegram")).toEqual({ ok: false, error: "Telegram: Bad Request: chat not found" });
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "err", message: "Test sent to Telegram" }));
  });
});
