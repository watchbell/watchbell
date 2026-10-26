import type { ChannelKind } from "@/db/schema";

export type ChannelConfig = {
  telegram: { chatId: string; chatLabel: string };
  discord: { url: string };
  // 1.2.3: a generic outgoing webhook; `secret` (may be empty) signs each body.
  webhook: { url: string; secret: string };
  // 1.2.3: alerts by email through the user's own mail server (lib/notify/smtp.ts).
  smtp: { host: string; port: 465 | 587 | 2525; user: string; pass: string; from: string; to: string };
  email_digest: { to: string };
};

// What the Notifications tab may show of a saved channel: enough to recognise it, never the secret itself (R7).
// Telegram: the chat's name and the last 4 characters of its id. Discord: the last 4 of the webhook id (the token part
// stays hidden). Webhook: the host only (the path often carries a token). Digest: the first 2 letters of the address.
export function maskHint<K extends ChannelKind>(kind: K, config: ChannelConfig[K]): string {
  if (kind === "telegram") {
    const c = config as ChannelConfig["telegram"];
    return `${c.chatLabel || "Chat"} · …${c.chatId.slice(-4)}`;
  }
  if (kind === "discord") {
    const id = /\/webhooks\/(\d+)\//.exec((config as ChannelConfig["discord"]).url)?.[1] ?? "";
    return `webhook …${id.slice(-4)}`;
  }
  if (kind === "webhook") {
    const c = config as ChannelConfig["webhook"];
    let host = "";
    try {
      host = new URL(c.url).hostname;
    } catch {
      host = "?";
    }
    return `${host}/…${c.secret ? " · signed" : ""}`;
  }
  if (kind === "smtp") {
    const c = config as ChannelConfig["smtp"];
    return `${c.host}:${c.port} · to ${c.to.slice(0, 2)}…@…`;
  }
  return `${(config as ChannelConfig["email_digest"]).to.slice(0, 2)}…@…`;
}
