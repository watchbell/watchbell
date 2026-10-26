import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { findChats, sendTelegram } from "./telegram";

// Catch-all as in osv.test.ts: an unmatched request is recorded and fails, so no test can reach a real host.
const unmatched: string[] = [];
const server = setupServer(http.all("*", ({ request }) => { unmatched.push(`${request.method} ${request.url}`); return HttpResponse.error(); }));
afterEach(() => { const leaked = unmatched.splice(0); expect(leaked).toEqual([]); });
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
const TOKEN = "123456:ABCdefGHIjklMNOpqrSTUvwxYZ";
const BASE = `https://api.telegram.org/bot${TOKEN}`;

describe("sendTelegram", () => {
  it("posts HTML without link previews", async () => {
    let body: unknown;
    server.use(http.post(`${BASE}/sendMessage`, async ({ request }) => { body = await request.json(); return HttpResponse.json({ ok: true, result: { message_id: 1 } }); }));
    expect(await sendTelegram(TOKEN, "42", "<b>hi</b>")).toEqual({ ok: true, messageId: 1 });
    expect(body).toEqual({ chat_id: "42", text: "<b>hi</b>", parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });
  // Watchbell 1.2.2 (D18): an auto-action's notice answers its alert's message.
  it("replies to a message when asked, and still sends if that message is gone", async () => {
    let body: unknown;
    server.use(http.post(`${BASE}/sendMessage`, async ({ request }) => { body = await request.json(); return HttpResponse.json({ ok: true, result: { message_id: 77 } }); }));
    expect(await sendTelegram(TOKEN, "42", "x", { replyTo: 31 })).toEqual({ ok: true, messageId: 77 });
    expect(body).toMatchObject({ reply_parameters: { message_id: 31, allow_sending_without_reply: true } });
    for (const replyTo of [null, 0, -3, 1.5]) {
      await sendTelegram(TOKEN, "42", "x", { replyTo });
      expect(body).not.toHaveProperty("reply_parameters");
    }
  });
  it("answers without a message id when Telegram leaves it out", async () => {
    server.use(http.post(`${BASE}/sendMessage`, () => HttpResponse.json({ ok: true, result: {} })));
    expect(await sendTelegram(TOKEN, "42", "x")).toEqual({ ok: true });
  });
  it("reports flood control and a wrong chat", async () => {
    server.use(http.post(`${BASE}/sendMessage`, () => HttpResponse.json({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } }, { status: 429 })));
    expect(await sendTelegram(TOKEN, "42", "x")).toEqual({ ok: false, kind: "transient", retryAfterS: 7, error: "Telegram asked us to wait 7 s." });
    server.use(http.post(`${BASE}/sendMessage`, () => HttpResponse.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 400 })));
    expect(await sendTelegram(TOKEN, "42", "x")).toEqual({ ok: false, kind: "config", error: "Telegram: Bad Request: chat not found" });
  });
  it("treats a server error as transient and never puts the token in the message", async () => {
    server.use(http.post(`${BASE}/sendMessage`, () => new HttpResponse(null, { status: 502 })));
    const r = await sendTelegram(TOKEN, "42", "x");
    expect(r).toMatchObject({ ok: false, kind: "transient" });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

describe("findChats", () => {
  it("lists the chats that wrote to the bot, once each", async () => {
    server.use(http.get(`${BASE}/getUpdates`, () => HttpResponse.json({ ok: true, result: [
      { update_id: 1, message: { chat: { id: 42, type: "private", first_name: "Alex" } } },
      { update_id: 2, message: { chat: { id: 42, type: "private", first_name: "Alex" } } },
      { update_id: 3, message: { chat: { id: -100, type: "group", title: "Ops" } } },
    ] })));
    expect(await findChats(TOKEN)).toEqual({ ok: true, chats: [{ id: "42", label: "Alex (private)" }, { id: "-100", label: "Ops (group)" }] });
  });
  it("explains the webhook conflict", async () => {
    server.use(http.get(`${BASE}/getUpdates`, () => HttpResponse.json({ ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" }, { status: 409 })));
    expect(await findChats(TOKEN)).toEqual({ ok: false, error: "This bot has a webhook set, so the console can't list chats. Remove the webhook or paste the chat id." });
  });
});
