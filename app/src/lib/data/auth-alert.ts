import "server-only";
import { recordResult, telegramTarget } from "@/lib/data/notify-db";
import { type NotifyLang, readNotifyLang } from "@/lib/notify/lang";
import { type SendResult, sendTelegram } from "@/lib/notify/telegram";
import { limit } from "@/lib/rate-limit-db";

// Watchbell 1.2.1 (audit L5/L6): a Telegram notice when one account collects many failed passwords or MFA codes in a
// day (lib/backoff.ts ALERT_AFTER), at most once an hour per account and kind. The existing Telegram path (the connected
// chat, its send and its delivery record); no email, IP or name in the text. Never throws.
export type AuthFailureKind = "password" | "mfa";
export const AUTH_ALERT_LIMIT = { name: "auth-alert", max: 1, windowSeconds: 3600 } as const;

export function authFailureNotice(kind: AuthFailureKind, count: number, lang: NotifyLang = "en"): string {
  if (lang === "id") {
    const what = kind === "password" ? "password yang salah" : "kode authenticator yang salah";
    return `⚠️ Watchbell: ${count} kali ${what} untuk satu akun hari ini. Kalau itu bukan Anda, periksa siapa yang bisa membuka console.`;
  }
  const what = kind === "password" ? "wrong passwords" : "wrong authenticator codes";
  return `⚠️ Watchbell: ${count} ${what} for one account today. If that wasn't you, check who can reach the console.`;
}

export type AuthAlertDeps = {
  allowed: (kind: AuthFailureKind, subject: string) => Promise<boolean>;
  target: () => Promise<{ token: string; chatId: string } | null>;
  lang: () => Promise<NotifyLang>;
  send: (token: string, chatId: string, html: string) => Promise<SendResult>;
  record: (r: SendResult, now: Date) => Promise<void>;
};

const DEPS: AuthAlertDeps = {
  allowed: async (kind, subject) => (await limit(AUTH_ALERT_LIMIT, `${kind} ${subject}`)).allowed,
  target: telegramTarget,
  lang: () => readNotifyLang("telegram"),
  send: (token, chatId, html) => sendTelegram(token, chatId, html),
  record: (r, now) => recordResult("telegram", r, now),
};

// `subject`: the account (its email or user id); only its hash is stored by the hourly limit.
export async function notifyAuthFailures(kind: AuthFailureKind, subject: string, count: number, deps: AuthAlertDeps = DEPS): Promise<void> {
  try {
    if (!(await deps.allowed(kind, subject))) return;
    const t = await deps.target();
    if (!t) return;
    const r = await deps.send(t.token, t.chatId, authFailureNotice(kind, count, await deps.lang().catch(() => "en" as const)));
    await deps.record(r, new Date()).catch(() => undefined);
  } catch {
    console.warn("auth failure notice failed");
  }
}
