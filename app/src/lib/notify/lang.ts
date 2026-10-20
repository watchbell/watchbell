import { readNotifyLangSetting } from "@/lib/data/settings-db";

// The language of what Watchbell sends, set per channel (Telegram, Discord, the email digest). The web UI stays English.
// Saved in ops.settings (settings-db); missing or odd means English.
export type NotifyLang = "en" | "id";

export function parseNotifyLang(raw: unknown): NotifyLang {
  return typeof raw === "string" && raw.trim().toLowerCase() === "id" ? "id" : "en";
}

export type NotifyChannel = "telegram" | "discord" | "email";
export const NOTIFY_CHANNELS: readonly NotifyChannel[] = ["telegram", "discord", "email"];
export type NotifyLangs = Record<NotifyChannel, NotifyLang>;

// Stored in notify.language as { telegram, discord, email }. The older { lang } (or a bare string) means that language for
// all three; a channel key wins over it; anything missing or odd is English.
export function parseNotifyLangs(raw: unknown): NotifyLangs {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const base = obj ? obj.lang : raw;
  const pick = (c: NotifyChannel) => parseNotifyLang(obj && c in obj ? obj[c] : base);
  return { telegram: pick("telegram"), discord: pick("discord"), email: pick("email") };
}

// One settings read for all channels. Never throws and never caches: a sender that can't read the setting still sends, in English.
export async function readNotifyLangs(): Promise<NotifyLangs> {
  try {
    return parseNotifyLangs(await readNotifyLangSetting());
  } catch {
    return parseNotifyLangs(null);
  }
}

// No argument means Telegram (every sender except Discord and the email digest writes to Telegram).
export async function readNotifyLang(channel: NotifyChannel = "telegram"): Promise<NotifyLang> {
  return (await readNotifyLangs())[channel];
}

// One message table per language: t({ en: {...}, id: {...} }, lang, "key"). The key set is the same in both.
export function t<K extends string>(table: Record<NotifyLang, Record<K, string>>, lang: NotifyLang, key: K): string {
  return table[lang][key];
}
