import { describe, expect, it, vi } from "vitest";
import { ENV_COPY } from "@/lib/copy/edition";
import {
  ALLOWED_UPDATES, botClient, deleteWebhook, getUpdates, getWebhookInfo, hashLinkCode, LINK_CODE_LENGTH, newLinkCode, newWebhookSecret, noteRejected, parseLinkCommand,
  parseUpdate, rejectedWebhookCalls, secretMatches, setWebhook,
} from "./telegram-bot";

// Never a real token: every call goes to the fake fetch below.
const TOKEN = "123456:fake-token-for-tests-only-000000";

function fakeFetch(answer: unknown = { ok: true, result: true }, status = 200) {
  const calls: { url: string; body: unknown }[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(answer), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("secret verification", () => {
  it("matches only the exact secret", () => {
    const s = newWebhookSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secretMatches(s, s)).toBe(true);
    expect(secretMatches(`${s}x`, s)).toBe(false);
    expect(secretMatches(s.slice(0, -1), s)).toBe(false);
    expect(secretMatches(newWebhookSecret(), s)).toBe(false);
  });
  it("refuses a missing header or a missing secret", () => {
    expect(secretMatches(null, "abc")).toBe(false);
    expect(secretMatches("", "")).toBe(false);
    expect(secretMatches("abc", null)).toBe(false);
    expect(secretMatches(undefined, undefined)).toBe(false);
  });
  it("counts rejected calls", () => {
    const before = rejectedWebhookCalls();
    noteRejected();
    expect(rejectedWebhookCalls()).toBe(before + 1);
  });
});

describe("link codes", () => {
  it("are 8 characters without look-alikes, and the hash ignores case and spaces", () => {
    const c = newLinkCode();
    expect(c).toHaveLength(LINK_CODE_LENGTH);
    expect(c).toMatch(/^[A-HJKMNP-Z2-9]+$/);
    expect(hashLinkCode(c)).toBe(hashLinkCode(` ${c.toLowerCase()} `));
    expect(hashLinkCode(c)).not.toContain(c);
  });
  it("reads /link CODE and /link@Bot CODE, nothing else", () => {
    expect(parseLinkCommand("/link abcd2345")).toBe("ABCD2345");
    expect(parseLinkCommand("/link@watchpost_demo_bot ABCD2345")).toBe("ABCD2345");
    expect(parseLinkCommand("/link")).toBeNull();
    expect(parseLinkCommand("hi /link ABCD2345")).toBeNull();
    expect(parseLinkCommand("/link ABCD 2345")).toBeNull();
    expect(parseLinkCommand(undefined)).toBeNull();
  });
});

describe("parseUpdate (strict)", () => {
  it("keeps the fields the console reads, ids as strings", () => {
    const u = parseUpdate({
      update_id: 1, extra: "dropped",
      callback_query: { id: "q1", from: { id: 42, first_name: "x" }, data: "p:x", message: { message_id: 7, chat: { id: -100123, type: "group", title: "Ops" } } },
    });
    expect(u?.callback_query).toEqual({ id: "q1", from: { id: "42" }, data: "p:x", message: { message_id: 7, chat: { id: "-100123", type: "group", title: "Ops" } } });
    expect(u).not.toHaveProperty("extra");
  });
  it("rejects what isn't an update", () => {
    expect(parseUpdate(null)).toBeNull();
    expect(parseUpdate([])).toBeNull();
    expect(parseUpdate({})).toBeNull();
    expect(parseUpdate({ update_id: "1" })).toBeNull();
    expect(parseUpdate({ update_id: 1, message: { message_id: 1, chat: { id: "abc" } } })).toBeNull();
    expect(parseUpdate({ update_id: 1, callback_query: { id: "q", from: { id: 1 }, data: "x".repeat(65) } })).toBeNull();
  });
  it("accepts an update kind it doesn't handle (ignored later)", () => {
    expect(parseUpdate({ update_id: 3, edited_message: { text: "x" } })).toEqual({ update_id: 3 });
  });
});

describe("Bot API calls (fake fetch)", () => {
  it("setWebhook sends the url, the secret and only message + callback_query", async () => {
    const { f, calls } = fakeFetch();
    expect(await setWebhook(TOKEN, "https://ops.example.test/api/telegram/webhook", "sec", { fetch: f })).toEqual({ ok: true });
    expect(calls[0].url).toMatch(/\/setWebhook$/);
    expect(calls[0].body).toMatchObject({ url: "https://ops.example.test/api/telegram/webhook", secret_token: "sec", allowed_updates: [...ALLOWED_UPDATES] });
  });
  it("words Telegram's errors without the token", async () => {
    const { f } = fakeFetch({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
    const r = await setWebhook(TOKEN, "https://x.test/h", "s", { fetch: f });
    expect(r).toEqual({ ok: false, error: `Telegram rejected TELEGRAM_BOT_TOKEN. Check the value ${ENV_COPY.checkWhere}.` });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    const bad = fakeFetch({ ok: false, error_code: 400, description: "bad webhook: HTTPS url must be provided" }, 400);
    expect(await deleteWebhook(TOKEN, { fetch: bad.f })).toEqual({ ok: false, error: "Telegram: bad webhook: HTTPS url must be provided" });
  });
  it("getUpdates builds the long-poll URL and maps 409 to conflict", async () => {
    const { f, calls } = fakeFetch({ ok: true, result: [{ update_id: 5 }] });
    expect(await getUpdates(TOKEN, 6, { fetch: f })).toEqual({ ok: true, updates: [{ update_id: 5 }] });
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=6&timeout=25&allowed_updates=${encodeURIComponent(JSON.stringify(ALLOWED_UPDATES))}`);
    const c = fakeFetch({ ok: false, error_code: 409, description: "Conflict: can't use getUpdates while webhook is active" }, 409);
    const r = await getUpdates(TOKEN, 0, { fetch: c.f });
    expect(r).toMatchObject({ ok: false, conflict: true });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    const other = await getUpdates(TOKEN, 0, { fetch: fakeFetch({ ok: false, error_code: 500, description: "x" }, 500).f });
    expect(other.ok).toBe(false);
    expect((other as { conflict?: boolean }).conflict).toBeUndefined();
  });
  it("getWebhookInfo reads the url, the queue and the last error", async () => {
    const { f } = fakeFetch({ ok: true, result: { url: "https://x.test/h", pending_update_count: 2, last_error_date: 1_700_000_000, last_error_message: "Wrong response from the webhook: 401" } });
    const r = await getWebhookInfo(TOKEN, { fetch: f });
    expect(r).toEqual({ ok: true, info: { url: "https://x.test/h", pending: 2, lastError: "Wrong response from the webhook: 401", lastErrorAt: new Date(1_700_000_000_000) } });
  });
  it("the client answers, edits and removes buttons", async () => {
    const { f, calls } = fakeFetch();
    const c = botClient(TOKEN, { fetch: f });
    await c.answer("q1", "Not you 🙂");
    await c.editText("-1", 7, "<b>x</b>", null);
    await c.editKeyboard("-1", 7, { inline_keyboard: [[{ text: "a", callback_data: "b" }]] });
    expect(calls.map((x) => x.url.split("/").pop())).toEqual(["answerCallbackQuery", "editMessageText", "editMessageReplyMarkup"]);
    expect(calls[0].body).toEqual({ callback_query_id: "q1", text: "Not you 🙂" });
    expect(calls[1].body).toMatchObject({ chat_id: "-1", message_id: 7, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } });
  });
});
