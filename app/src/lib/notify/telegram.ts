import { DEMO_UNAVAILABLE } from "@/lib/demo/simulate";
import { ENV_COPY } from "@/lib/copy/edition";
import { isDemo } from "@/lib/mode";

// Telegram Bot API (core.telegram.org/bots/api): POST /bot<token>/sendMessage; every answer is { ok, result } or
// { ok: false, error_code, description, parameters?: { retry_after } }. The token is never logged or put in an error.
export type SendResult = { ok: true } | { ok: false; kind: "config" | "transient"; error: string; retryAfterS?: number };

const base = (token: string) => `https://api.telegram.org/bot${token}`;

export async function telegramCall(token: string, method: string, init: RequestInit, f: typeof fetch, timeoutMs = 5000): Promise<{ ok: true; result: unknown } | { ok: false; code: number | null; description: string; retryAfter: number | null }> {
  // Demo: no message, webhook or update call ever leaves the server (every Bot API call goes through here).
  if (isDemo()) return { ok: false, code: null, description: DEMO_UNAVAILABLE, retryAfter: null };
  let res: Response;
  try {
    res = await f(`${base(token)}/${method}`, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  } catch {
    return { ok: false, code: null, description: "Telegram didn't answer.", retryAfter: null };
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown; error_code?: number; description?: string; parameters?: { retry_after?: number } } | null;
  if (body?.ok) return { ok: true, result: body.result };
  return { ok: false, code: body?.error_code ?? res.status, description: String(body?.description ?? `HTTP ${res.status}`).slice(0, 200), retryAfter: body?.parameters?.retry_after ?? null };
}

// replyMarkup (Stage 9 slice 7): an inline keyboard under the message, e.g. the proposal approval buttons.
export async function sendTelegram(token: string, chatId: string, html: string, opts: { fetch?: typeof fetch; replyMarkup?: unknown } = {}): Promise<SendResult> {
  const r = await telegramCall(token, "sendMessage", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}) }),
  }, opts.fetch ?? fetch);
  if (r.ok) return { ok: true };
  if (r.code === 429) return { ok: false, kind: "transient", retryAfterS: r.retryAfter ?? 30, error: `Telegram asked us to wait ${r.retryAfter ?? 30} s.` };
  if (r.code === null || r.code >= 500) return { ok: false, kind: "transient", error: r.code === null ? r.description : `Telegram returned an error (${r.code}).` };
  return { ok: false, kind: "config", error: `Telegram: ${r.description}` };
}

type Chat = { id?: number; type?: string; title?: string; first_name?: string; username?: string };

export async function findChats(token: string, opts: { fetch?: typeof fetch } = {}): Promise<{ ok: true; chats: { id: string; label: string }[] } | { ok: false; error: string }> {
  const r = await telegramCall(token, "getUpdates?limit=20&timeout=0", { method: "GET" }, opts.fetch ?? fetch);
  if (!r.ok) {
    if (r.code === 409) return { ok: false, error: "This bot has a webhook set, so the console can't list chats. Remove the webhook or paste the chat id." };
    if (r.code === 401 || r.code === 404) return { ok: false, error: `Telegram rejected TELEGRAM_BOT_TOKEN. Check the value ${ENV_COPY.checkWhere}.` };
    return { ok: false, error: "Couldn't reach Telegram. Try again." };
  }
  const seen = new Map<string, string>();
  for (const u of Array.isArray(r.result) ? (r.result as { message?: { chat?: Chat }; my_chat_member?: { chat?: Chat }; channel_post?: { chat?: Chat } }[]) : []) {
    const c = u.message?.chat ?? u.my_chat_member?.chat ?? u.channel_post?.chat;
    if (!c || typeof c.id !== "number") continue;
    seen.set(String(c.id), `${c.title ?? c.first_name ?? c.username ?? "Chat"} (${c.type ?? "chat"})`);
  }
  return { ok: true, chats: [...seen].map(([id, label]) => ({ id, label })) };
}
