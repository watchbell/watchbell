import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ENV_COPY } from "@/lib/copy/edition";
import { z } from "zod";
import { telegramCall } from "./telegram";

// Stage 9 slice 7: the bot's webhook (core.telegram.org/bots/api#setwebhook) and the few Bot API calls the approval
// buttons need. Telegram sends every update to POST /api/telegram/webhook with the header X-Telegram-Bot-Api-Secret-Token
// set to the secret_token given to setWebhook; the console keeps that secret sealed in ops.settings. The bot token, the
// secret, chat ids and Telegram user ids never go into a log, an error text or the browser.

export const WEBHOOK_PATH = "/api/telegram/webhook";
export const ALLOWED_UPDATES = ["message", "callback_query"] as const;

export type InlineButton = { text: string; callback_data: string };
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };
export const NO_BUTTONS: InlineKeyboard = { inline_keyboard: [] };

// ---- pure helpers ----

// 32 random bytes as base64url: 43 characters of [A-Za-z0-9_-], inside Telegram's secret_token rules (1–256 of those).
export const newWebhookSecret = (): string => randomBytes(32).toString("base64url");

// Constant-time: both sides hashed first, so neither the length nor the content leaks through timing.
export function secretMatches(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (typeof given !== "string" || typeof expected !== "string" || !given || !expected) return false;
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

// Requests to the webhook with a missing or wrong secret: counted per instance, never logged.
let rejected = 0;
export const noteRejected = (): void => { rejected++; };
export const rejectedWebhookCalls = (): number => rejected;

// The one-time /link code: 8 characters without look-alikes (no 0/O, 1/I/L).
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const LINK_CODE_LENGTH = 8;
export function newLinkCode(): string {
  const bytes = randomBytes(LINK_CODE_LENGTH);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}
export const hashLinkCode = (code: string): string => createHash("sha256").update(`watchpost:telegram-link:${code.trim().toUpperCase()}`, "utf8").digest("hex");

// "/link CODE" or "/link@SomeBot CODE" → the code (upper-cased), or null for anything else.
export function parseLinkCommand(text: string | undefined): string | null {
  const m = /^\/link(?:@[A-Za-z0-9_]{3,64})?\s+([A-Za-z0-9]{4,16})\s*$/.exec(text ?? "");
  return m ? m[1].toUpperCase() : null;
}

// ---- the update, parsed strictly: only the fields the console reads; anything else is dropped ----
const id = z.union([z.number().int(), z.string().regex(/^-?\d{1,20}$/)]).transform((v) => String(v));
const chat = z.object({ id, type: z.string().max(32).optional(), title: z.string().max(256).optional(), first_name: z.string().max(256).optional(), username: z.string().max(64).optional() });
const user = z.object({ id, is_bot: z.boolean().optional() });
const message = z.object({ message_id: z.number().int(), chat, from: user.optional(), text: z.string().max(4096).optional() });
const updateSchema = z.object({
  update_id: z.number().int(),
  message: message.optional(),
  callback_query: z.object({ id: z.string().min(1).max(128), from: user, message: message.optional(), data: z.string().max(64).optional() }).optional(),
});

export type TgChat = z.infer<typeof chat>;
export type TgUpdate = z.infer<typeof updateSchema>;

// A callback the core checked: it came from the connected chat and the linked owner. Handlers get only this.
export type TelegramCallback = { queryId: string; data: string; chatId: string; messageId: number };
export type TelegramOwner = { memberId: string; userId: string };

export function parseUpdate(raw: unknown): TgUpdate | null {
  const r = updateSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export const chatLabel = (c: TgChat): string => `${(c.title ?? c.first_name ?? c.username ?? "Chat").slice(0, 50)} (${c.type ?? "chat"})`;

// ---- Bot API calls (each one bounded by telegramCall's 5 s timeout; never throws) ----
type F = { fetch?: typeof fetch };
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function problem(r: { code: number | null; description: string }): string {
  if (r.code === 401 || r.code === 404) return `Telegram rejected TELEGRAM_BOT_TOKEN. Check the value ${ENV_COPY.checkWhere}.`;
  if (r.code === null) return "Couldn't reach Telegram. Try again.";
  return `Telegram: ${r.description}`;
}

export async function setWebhook(token: string, url: string, secret: string, opts: F = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await telegramCall(token, "setWebhook", post({ url, secret_token: secret, allowed_updates: ALLOWED_UPDATES, drop_pending_updates: true, max_connections: 5 }), opts.fetch ?? fetch);
  return r.ok ? { ok: true } : { ok: false, error: problem(r) };
}

export async function deleteWebhook(token: string, opts: F = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await telegramCall(token, "deleteWebhook", post({ drop_pending_updates: false }), opts.fetch ?? fetch);
  return r.ok ? { ok: true } : { ok: false, error: problem(r) };
}

// Long polling for selfhost (no public URL, so no webhook). `timeoutS` is how long Telegram holds the request open when
// there is nothing new; the client timeout is that plus a margin. 409 = a webhook is still set for this bot.
export const POLL_TIMEOUT_S = 25;
export async function getUpdates(token: string, offset: number, opts: { timeoutS?: number; fetch?: typeof fetch } = {}): Promise<{ ok: true; updates: unknown[] } | { ok: false; error: string; conflict?: boolean }> {
  const timeoutS = opts.timeoutS ?? POLL_TIMEOUT_S;
  const method = `getUpdates?offset=${Math.trunc(offset)}&timeout=${timeoutS}&allowed_updates=${encodeURIComponent(JSON.stringify(ALLOWED_UPDATES))}`;
  const r = await telegramCall(token, method, { method: "GET" }, opts.fetch ?? fetch, (timeoutS + 10) * 1000);
  if (r.ok) return { ok: true, updates: Array.isArray(r.result) ? r.result : [] };
  return r.code === 409 ? { ok: false, error: problem(r), conflict: true } : { ok: false, error: problem(r) };
}

export type WebhookInfo = { url: string; pending: number; lastError: string | null; lastErrorAt: Date | null };

export async function getWebhookInfo(token: string, opts: F = {}): Promise<{ ok: true; info: WebhookInfo } | { ok: false; error: string }> {
  const r = await telegramCall(token, "getWebhookInfo", { method: "GET" }, opts.fetch ?? fetch);
  if (!r.ok) return { ok: false, error: problem(r) };
  const i = (r.result ?? {}) as { url?: unknown; pending_update_count?: unknown; last_error_date?: unknown; last_error_message?: unknown };
  return {
    ok: true,
    info: {
      url: typeof i.url === "string" ? i.url : "",
      pending: typeof i.pending_update_count === "number" ? i.pending_update_count : 0,
      lastError: typeof i.last_error_message === "string" ? i.last_error_message.slice(0, 200) : null,
      lastErrorAt: typeof i.last_error_date === "number" ? new Date(i.last_error_date * 1000) : null,
    },
  };
}

// What a webhook handler does in Telegram. A fake one in the tests; botClient() is the real one.
export type BotClient = {
  answer: (queryId: string, text: string) => Promise<void>;
  editText: (chatId: string, messageId: number, html: string, keyboard: InlineKeyboard | null) => Promise<void>;
  editKeyboard: (chatId: string, messageId: number, keyboard: InlineKeyboard) => Promise<void>;
  send: (chatId: string, html: string) => Promise<void>;
};

export function botClient(token: string, opts: F = {}): BotClient {
  const f = opts.fetch ?? fetch;
  const go = async (method: string, body: unknown) => {
    const r = await telegramCall(token, method, post(body), f);
    // "message is not modified" is fine (a double tap); anything else is one line without ids or text.
    if (!r.ok && !/not modified/i.test(r.description)) console.warn(`telegram ${method} failed (${r.code ?? "network"})`);
  };
  return {
    answer: (queryId, text) => go("answerCallbackQuery", { callback_query_id: queryId, text: text.slice(0, 200) }),
    editText: (chatId, messageId, html, keyboard) => go("editMessageText", {
      chat_id: chatId, message_id: messageId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard ?? NO_BUTTONS,
    }),
    editKeyboard: (chatId, messageId, keyboard) => go("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: keyboard }),
    send: (chatId, html) => go("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
  };
}
