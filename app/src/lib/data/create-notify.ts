import "server-only";
import { esc } from "@/lib/alerts/compose";
import { type CreateType, PAGE_OF, PROVIDER_NAME, TYPE_LABEL } from "@/lib/create/types";
import { recordResult, telegramTarget } from "@/lib/data/notify-db";
import { serverEnv } from "@/lib/env";
import { type NotifyLang, readNotifyLang } from "@/lib/notify/lang";
import { type SendResult, sendTelegram } from "@/lib/notify/telegram";

// Stage 6 create requests: a short Telegram notice when someone asks for a create, with a link to approve it in the
// console. Never approval buttons: approving a create needs the Owner's authenticator code (aal2) in the console.
// No names, hosts or emails: only the kind of resource and the provider. Never throws.

export function createNotice(type: CreateType, id: string, siteUrl: string, lang: NotifyLang = "en"): string {
  const url = `${siteUrl.replace(/\/+$/, "")}${PAGE_OF[type]}?create=${encodeURIComponent(id)}`;
  return [
    lang === "id"
      ? `🙋 Permintaan baru: bikin ${esc(TYPE_LABEL[type])} di ${esc(PROVIDER_NAME[type])}.`
      : `🙋 New request: create ${esc(TYPE_LABEL[type])} on ${esc(PROVIDER_NAME[type])}.`,
    lang === "id"
      ? "Butuh persetujuan Owner (pakai kode authenticator) di console, berlaku 24 jam:"
      : "Needs Owner approval (with the authenticator code) in the console, valid for 24 hours:",
    esc(url),
  ].join("\n");
}

export type CreateNotifyDeps = {
  target: () => Promise<{ token: string; chatId: string } | null>;
  siteUrl: () => string;
  lang: () => Promise<NotifyLang>;
  send: (token: string, chatId: string, html: string) => Promise<SendResult>;
  record: (r: SendResult, now: Date) => Promise<void>;
};

const DEPS: CreateNotifyDeps = {
  target: telegramTarget,
  siteUrl: () => serverEnv().SITE_URL,
  lang: () => readNotifyLang("telegram"),
  send: (token, chatId, html) => sendTelegram(token, chatId, html),
  record: (r, now) => recordResult("telegram", r, now),
};

export async function notifyCreateRequest(row: { id: string; type: CreateType }, deps: CreateNotifyDeps = DEPS): Promise<void> {
  try {
    const t = await deps.target();
    if (!t) return;
    const r = await deps.send(t.token, t.chatId, createNotice(row.type, row.id, deps.siteUrl(), await deps.lang().catch(() => "en" as const)));
    await deps.record(r, new Date()).catch(() => undefined);
  } catch {
    console.warn("create notice failed");
  }
}
