import { telegramTarget } from "@/lib/data/notify-db";
import { linkedOwner, recordSeenChat, redeemLinkCode } from "@/lib/data/telegram-bot-db";
import { extensions } from "@/lib/extensions";
import { notifyEnv } from "./env";
import { botClient } from "./telegram-bot";
import type { UpdateDeps } from "./telegram-updates";

// The real deps for handleUpdate, shared by the webhook route (cloud) and the long-poll loop (selfhost).
export async function updateDeps(): Promise<UpdateDeps> {
  const token = notifyEnv().telegramToken;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN isn't set");
  return {
    client: botClient(token),
    connectedChat: async () => (await telegramTarget())?.chatId ?? null,
    owner: linkedOwner,
    redeem: redeemLinkCode,
    seen: recordSeenChat,
    onCallback: extensions.telegramCallback ?? null,
  };
}
