import { type NotifyLang, readNotifyLang, t } from "./lang";
import { type BotClient, chatLabel, parseLinkCommand, type TelegramCallback, type TelegramOwner, type TgUpdate } from "./telegram-bot";

// Stage 9 slice 7: what the console does with one webhook update (the route checked the secret already). Pure apart
// from its deps, so the tests drive it with fakes:
//   - every chat an update comes from is remembered (sealed) for Find chats while the webhook is on;
//   - "/link CODE" in the connected chat links the sender as the owner (the code from Alerts → Notifications);
//   - a button tap (callback_query) reaches the handler only from the connected chat AND the linked owner; anyone else
//     gets "Not you 🙂" and nothing happens.
// Anything else is ignored. Never throws.

// What the bot says back, in the notification language (notify.language, read when it replies).
export const MSG = {
  en: {
    notYou: "Not you 🙂", notActive: "This button is no longer active.",
    linked: "✅ Your Telegram account is linked. The Approve / Reject buttons now obey only you.",
    wrong: "Wrong code. Get a new code in Alerts → Notifications if needed.",
    expired: "The code has expired. Get a new code in Alerts → Notifications.",
  },
  id: {
    notYou: "Bukan kamu 🙂", notActive: "Tombol ini udah nggak aktif.",
    linked: "✅ Akun Telegram kamu tersambung. Tombol Setujui / Tolak sekarang cuma nurut sama kamu.",
    wrong: "Kode salah. Ambil kode baru di Alerts → Notifications kalau perlu.",
    expired: "Kodenya udah kedaluwarsa. Ambil kode baru di Alerts → Notifications.",
  },
};

export type CallbackHandler = (q: TelegramCallback, ctx: { client: BotClient; owner: TelegramOwner; now: Date }) => Promise<void>;

export type UpdateDeps = {
  client: BotClient;
  connectedChat: () => Promise<string | null>;
  owner: () => Promise<(TelegramOwner & { telegramUserId: string }) | null>;
  redeem: (code: string, telegramUserId: string, now: Date) => Promise<"linked" | "wrong" | "expired">;
  seen: (chat: { id: string; label: string }, now: Date) => Promise<void>;
  onCallback: CallbackHandler | null;
  lang?: () => Promise<NotifyLang>; // default: the saved notify.language
};

export async function handleUpdate(u: TgUpdate, deps: UpdateDeps, now = new Date()): Promise<void> {
  const say = async (key: keyof typeof MSG.en) => t(MSG, await (deps.lang ?? (() => readNotifyLang("telegram")))().catch(() => "en" as const), key);
  try {
    const chat = u.message?.chat ?? u.callback_query?.message?.chat;
    if (chat) await deps.seen({ id: chat.id, label: chatLabel(chat) }, now).catch(() => console.warn("telegram webhook: remembering the chat failed"));

    if (u.message) {
      const code = parseLinkCommand(u.message.text);
      const from = u.message.from;
      if (!code || !from || from.is_bot) return;
      const connected = await deps.connectedChat();
      // Only in the connected chat; elsewhere the bot stays silent.
      if (!connected || connected !== u.message.chat.id) return;
      const r = await deps.redeem(code, from.id, now);
      await deps.client.send(connected, await say(r));
      return;
    }

    const q = u.callback_query;
    if (!q) return;
    const msg = q.message;
    if (!msg || !q.data) {
      await deps.client.answer(q.id, await say("notActive"));
      return;
    }
    const [connected, owner] = await Promise.all([deps.connectedChat(), deps.owner()]);
    if (!connected || connected !== msg.chat.id || !owner || owner.telegramUserId !== q.from.id) {
      await deps.client.answer(q.id, await say("notYou"));
      return;
    }
    if (!deps.onCallback) {
      await deps.client.answer(q.id, await say("notActive"));
      return;
    }
    await deps.onCallback({ queryId: q.id, data: q.data, chatId: msg.chat.id, messageId: msg.message_id }, {
      client: deps.client, owner: { memberId: owner.memberId, userId: owner.userId }, now,
    });
  } catch (e) {
    console.warn("telegram webhook: handling the update failed:", e instanceof Error ? e.name : "error");
  }
}
