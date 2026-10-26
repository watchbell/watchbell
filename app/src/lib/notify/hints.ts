import type { ChannelKind } from "@/db/schema";

// 1.2.4 (owner 26 Oct: like Grafana, one alert to several people): the addresses in an SMTP `to`, split on commas,
// semicolons or spaces, without repeats (case-insensitive). At most MAX_RECIPIENTS are allowed when saving.
export const MAX_RECIPIENTS = 10;
export function recipients(to: string): string[] {
  const seen = new Set<string>();
  return to.split(/[\s,;]+/).filter((a) => a && !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()));
}

export type ChannelConfig = {
  telegram: { chatId: string; chatLabel: string };
  discord: { url: string };
  // 1.2.3: a generic outgoing webhook; `secret` (may be empty) signs each body.
  webhook: { url: string; secret: string };
  // 1.2.3: alerts by email through the user's own mail server (lib/notify/smtp.ts).
  // `to` (1.2.4) is one address or several, comma-separated (see recipients).
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
    const list = recipients(c.to);
    return `${c.host}:${c.port} · to ${(list[0] ?? "").slice(0, 2)}…@…${list.length > 1 ? ` +${list.length - 1}` : ""}`;
  }
  return `${(config as ChannelConfig["email_digest"]).to.slice(0, 2)}…@…`;
}
