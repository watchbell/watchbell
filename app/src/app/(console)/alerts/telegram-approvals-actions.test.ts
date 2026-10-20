import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_COPY } from "@/lib/copy/edition";
import { AuthError } from "@/lib/action";

const member = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };
const TOKEN = "123456:fake-token-for-tests-only-000000";
const HOOK = "https://ops.example.test/api/telegram/webhook";

const h = vi.hoisted(() => ({
  requireActionMember: vi.fn(), limit: vi.fn(), recordAction: vi.fn(), telegramTarget: vi.fn(), notifyEnv: vi.fn(), siteUrl: vi.fn(),
  webhookOn: vi.fn(), ownerLinked: vi.fn(), saveWebhookSecret: vi.fn(), clearWebhookSecret: vi.fn(), clearSeenChats: vi.fn(), createLinkCode: vi.fn(),
  setWebhook: vi.fn(), deleteWebhook: vi.fn(), getWebhookInfo: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/data/notify-db", () => ({ telegramTarget: h.telegramTarget }));
vi.mock("@/lib/notify/env", () => ({ notifyEnv: h.notifyEnv }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ SITE_URL: h.siteUrl() }) }));
vi.mock("@/lib/data/telegram-bot-db", () => ({
  webhookOn: h.webhookOn, ownerLinked: h.ownerLinked, saveWebhookSecret: h.saveWebhookSecret, clearWebhookSecret: h.clearWebhookSecret,
  clearSeenChats: h.clearSeenChats, createLinkCode: h.createLinkCode,
}));
vi.mock("@/lib/notify/telegram-bot", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify/telegram-bot")>()), setWebhook: h.setWebhook, deleteWebhook: h.deleteWebhook, getWebhookInfo: h.getWebhookInfo,
}));
vi.mock("@/lib/notify/telegram", () => ({ telegramCall: () => { throw new Error("no network in tests"); } }));

import { approvalsStatus, disableApprovals, enableApprovals, telegramLinkCode } from "./telegram-approvals-actions";

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(member);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.recordAction.mockResolvedValue(undefined);
  h.notifyEnv.mockReturnValue({ telegramToken: TOKEN });
  h.siteUrl.mockReturnValue("https://ops.example.test/");
  h.telegramTarget.mockResolvedValue({ token: TOKEN, chatId: "-1" });
  h.webhookOn.mockResolvedValue(true);
  h.ownerLinked.mockResolvedValue(false);
  h.setWebhook.mockResolvedValue({ ok: true });
  h.deleteWebhook.mockResolvedValue({ ok: true });
  h.getWebhookInfo.mockResolvedValue({ ok: true, info: { url: HOOK, pending: 0, lastError: null, lastErrorAt: null } });
});

describe("owner only", () => {
  it("refuses anyone else before touching Telegram or the store", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    for (const r of [await approvalsStatus(), await enableApprovals(), await disableApprovals(), await telegramLinkCode()]) expect(r.ok).toBe(false);
    expect(h.requireActionMember.mock.calls.every((c) => c[0] === "owner")).toBe(true);
    expect(h.setWebhook).not.toHaveBeenCalled();
    expect(h.deleteWebhook).not.toHaveBeenCalled();
    expect(h.createLinkCode).not.toHaveBeenCalled();
  });
});

describe("status in demo", () => {
  it("makes no call to Telegram (no webhook to compare), like selfhost", async () => {
    vi.stubEnv("WATCHPOST_MODE", "demo");
    try {
      expect(await approvalsStatus()).toMatchObject({ ok: true, data: { on: true, problem: null, pending: 0 } });
      expect(h.getWebhookInfo).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("enable in selfhost", () => {
  it("skips the https check and setWebhook, removes any webhook, and marks approvals on", async () => {
    vi.stubEnv("WATCHPOST_MODE", "selfhost");
    h.siteUrl.mockReturnValue("http://localhost:3000");
    try {
      const r = await enableApprovals();
      expect(r).toMatchObject({ ok: true, data: { on: true, problem: null } });
      expect(h.setWebhook).not.toHaveBeenCalled();
      expect(h.getWebhookInfo).not.toHaveBeenCalled();
      expect(h.deleteWebhook).toHaveBeenCalledWith(TOKEN);
      expect(h.saveWebhookSecret).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("does not mark approvals on when Telegram refuses deleteWebhook", async () => {
    vi.stubEnv("WATCHPOST_MODE", "selfhost");
    h.deleteWebhook.mockResolvedValue({ ok: false, error: "Telegram: nope" });
    try {
      expect(await enableApprovals()).toEqual({ ok: false, error: "Telegram: nope" });
      expect(h.saveWebhookSecret).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("enable", () => {
  it("stores a fresh secret first, then sets the webhook to SITE_URL + /api/telegram/webhook with it", async () => {
    const r = await enableApprovals();
    expect(r).toMatchObject({ ok: true, data: { on: true, linked: false, problem: null } });
    const secret = h.saveWebhookSecret.mock.calls[0][0] as string;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.setWebhook).toHaveBeenCalledWith(TOKEN, HOOK, secret);
    expect(h.saveWebhookSecret.mock.invocationCallOrder[0]).toBeLessThan(h.setWebhook.mock.invocationCallOrder[0]);
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "Telegram approval buttons turned on", resourceId: null, actorUserId: "user-1" });
    expect(JSON.stringify(h.recordAction.mock.calls)).not.toContain(secret);
  });
  it("Telegram refuses: the secret is dropped again", async () => {
    h.setWebhook.mockResolvedValue({ ok: false, error: "Telegram: bad webhook" });
    expect(await enableApprovals()).toEqual({ ok: false, error: "Telegram: bad webhook" });
    expect(h.clearWebhookSecret).toHaveBeenCalled();
  });
  it("needs the token, a connected chat and an https SITE_URL", async () => {
    h.telegramTarget.mockResolvedValueOnce(null);
    expect(await enableApprovals()).toEqual({ ok: false, error: "Connect Telegram and turn it on first." });
    h.siteUrl.mockReturnValue("http://localhost:3000");
    expect(await enableApprovals()).toEqual({ ok: false, error: "Telegram needs an https SITE_URL for its webhook." });
    h.notifyEnv.mockReturnValue({ telegramToken: null });
    expect(await enableApprovals()).toEqual({ ok: false, error: ENV_COPY.notSet("TELEGRAM_BOT_TOKEN") });
    expect(h.setWebhook).not.toHaveBeenCalled();
  });
});

describe("status", () => {
  it("off: no call to Telegram", async () => {
    h.webhookOn.mockResolvedValue(false);
    expect(await approvalsStatus()).toEqual({ ok: true, data: { on: false, linked: false, problem: null, pending: 0 } });
    expect(h.getWebhookInfo).not.toHaveBeenCalled();
  });
  it("on: shows Telegram's last delivery error, or a webhook pointing elsewhere", async () => {
    h.getWebhookInfo.mockResolvedValueOnce({ ok: true, info: { url: HOOK, pending: 3, lastError: "Wrong response from the webhook: 401 Unauthorized", lastErrorAt: new Date() } });
    expect(await approvalsStatus()).toMatchObject({ ok: true, data: { on: true, problem: "Telegram's last delivery failed: Wrong response from the webhook: 401 Unauthorized", pending: 3 } });
    h.getWebhookInfo.mockResolvedValueOnce({ ok: true, info: { url: "https://elsewhere.test/hook", pending: 0, lastError: null, lastErrorAt: null } });
    expect(await approvalsStatus()).toMatchObject({ data: { problem: expect.stringContaining("points somewhere else") } });
  });
});

describe("disable", () => {
  it("deletes the webhook, then the secret and the seen chats", async () => {
    expect(await disableApprovals()).toMatchObject({ ok: true, data: { on: false } });
    expect(h.deleteWebhook).toHaveBeenCalledWith(TOKEN);
    expect(h.clearWebhookSecret).toHaveBeenCalled();
    expect(h.clearSeenChats).toHaveBeenCalled();
  });
  it("keeps the secret when Telegram couldn't delete the webhook", async () => {
    h.deleteWebhook.mockResolvedValue({ ok: false, error: "Couldn't reach Telegram. Try again." });
    expect(await disableApprovals()).toEqual({ ok: false, error: "Couldn't reach Telegram. Try again." });
    expect(h.clearWebhookSecret).not.toHaveBeenCalled();
  });
});

describe("link code", () => {
  it("only while on; the code goes to this owner, never into the audit row", async () => {
    h.createLinkCode.mockResolvedValue({ code: "ABCD2345", expiresAt: new Date("2026-10-16T03:10:00.000Z") });
    expect(await telegramLinkCode()).toEqual({ ok: true, data: { code: "ABCD2345", expiresAt: "2026-10-16T03:10:00.000Z" } });
    expect(h.createLinkCode).toHaveBeenCalledWith("mem-1", expect.any(Date));
    expect(JSON.stringify(h.recordAction.mock.calls)).not.toContain("ABCD2345");
    h.webhookOn.mockResolvedValue(false);
    expect(await telegramLinkCode()).toEqual({ ok: false, error: "Turn the approval buttons on first." });
  });
});
