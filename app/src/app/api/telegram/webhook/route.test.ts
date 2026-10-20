import { beforeEach, describe, expect, it, vi } from "vitest";
import { isPublicPath } from "@/lib/paths";

const h = vi.hoisted(() => ({ secret: vi.fn(), after: vi.fn(), handle: vi.fn(), token: vi.fn() }));
vi.mock("next/server", () => ({ after: h.after }));
vi.mock("@/lib/data/telegram-bot-db", () => ({ webhookSecret: h.secret, linkedOwner: vi.fn(), recordSeenChat: vi.fn(), redeemLinkCode: vi.fn() }));
vi.mock("@/lib/data/notify-db", () => ({ telegramTarget: vi.fn() }));
vi.mock("@/lib/notify/env", () => ({ notifyEnv: () => ({ telegramToken: h.token() }) }));
vi.mock("@/lib/notify/telegram-updates", () => ({ handleUpdate: h.handle }));
vi.mock("@/lib/notify/telegram", () => ({ telegramCall: () => { throw new Error("no network in tests"); } }));

import { rejectedWebhookCalls } from "@/lib/notify/telegram-bot";
import { POST } from "./route";

const SECRET = "test-secret-not-real_0123456789";
const URL_ = "https://ops.example.test/api/telegram/webhook";
const post = (body: unknown, secret: string | null = SECRET) =>
  POST(new Request(URL_, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}) } }));

beforeEach(() => {
  vi.resetAllMocks();
  h.secret.mockResolvedValue(SECRET);
  h.token.mockReturnValue("123456:fake-token-for-tests-only-000000");
});

describe("POST /api/telegram/webhook", () => {
  it("is reachable without a session (the secret header is the credential)", () => {
    expect(isPublicPath("/api/telegram/webhook")).toBe(true);
    expect(isPublicPath("/api/telegram/other")).toBe(false);
  });
  it("401 for a missing or wrong secret, counted, nothing handled or logged", async () => {
    const warn = vi.spyOn(console, "warn");
    const before = rejectedWebhookCalls();
    expect((await post({ update_id: 1 }, null)).status).toBe(401);
    expect((await post({ update_id: 1 }, `${SECRET}x`)).status).toBe(401);
    expect(rejectedWebhookCalls()).toBe(before + 2);
    expect(h.after).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
  it("401 while the buttons are off (no secret stored), or the store can't be read", async () => {
    h.secret.mockResolvedValueOnce(null);
    expect((await post({ update_id: 1 })).status).toBe(401);
    h.secret.mockRejectedValueOnce(new Error("db down"));
    expect((await post({ update_id: 1 })).status).toBe(401);
  });
  it("200 at once for a valid update; the work runs after the response", async () => {
    const update = { update_id: 7, callback_query: { id: "q", from: { id: 1 }, data: "p:x", message: { message_id: 2, chat: { id: -3 } } } };
    const r = await post(update);
    expect(r.status).toBe(200);
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.handle).not.toHaveBeenCalled();
    await h.after.mock.calls[0][0]();
    expect(h.handle).toHaveBeenCalledWith(expect.objectContaining({ update_id: 7 }), expect.objectContaining({ onCallback: expect.any(Function) }));
  });
  it("200 and ignored: not JSON, not an update, too large, no bot token", async () => {
    expect((await post("{not json")).status).toBe(200);
    expect((await post({ hello: 1 })).status).toBe(200);
    expect((await post({ update_id: 1, message: { text: "x".repeat(70_000) } })).status).toBe(200);
    h.token.mockReturnValue(null);
    expect((await post({ update_id: 1 })).status).toBe(200);
    expect(h.after).not.toHaveBeenCalled();
  });
});
