"use server";

import { refresh } from "next/cache";
import { ENV_COPY } from "@/lib/copy/edition";
import { z } from "zod";
import { CHANNEL_KINDS, type ChannelKind } from "@/db/schema";
import { type ActionResult, type GuardMember, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { readNotifyLangSetting, saveNotifyLangs } from "@/lib/data/settings-db";
import { readChannel, sendTest as sendTestMessage, setChannelEnabled as storeEnabled, writeChannel } from "@/lib/data/notify-db";
import { readSeenChats, webhookOn } from "@/lib/data/telegram-bot-db";
import { webhookProblem } from "@/lib/notify/discord";
import { secretProblem, webhookUrlProblem } from "@/lib/notify/webhook";
import { smtpProblems } from "@/lib/notify/smtp";
import { notifyEnv } from "@/lib/notify/env";
import { NOTIFY_CHANNELS, type NotifyChannel, parseNotifyLangs } from "@/lib/notify/lang";
import { findChats } from "@/lib/notify/telegram";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

// Alerts → Notifications (spec §10, S6): Owners only. Every action is audited as an `action` event whose text names the
// channel and never the chat id, the webhook URL or the address (R7). The secrets are sealed before they are stored.
const deps = { requireActionMember };
const INVALID = "Something in that request wasn't valid.";
const NAME: Record<ChannelKind, string> = { telegram: "Telegram", discord: "Discord", webhook: "Webhook", smtp: "Email (SMTP)", email_digest: "Daily email digest" };

type Limited = typeof LIMITS.alertWrite | typeof LIMITS.notifyTest;

async function quota(member: GuardMember, which: Limited): Promise<{ ok: false; error: string } | null> {
  const q = await limit(which, member.id);
  return q.allowed ? null : { ok: false, error: `Too many changes. Try again in ${minutesText(q.retryAfter)}.` };
}

async function audit(member: GuardMember, kind: "ok" | "err", message: string) {
  await recordAction({ kind, message, resourceId: null, actorUserId: member.userId }).catch(() => console.warn("audit event failed"));
}

// Connect Telegram → Find chats: the chats that wrote to the bot lately. While the approval buttons are on (Stage 9
// slice 7) Telegram refuses getUpdates, so the list is the chats the webhook has seen since then (sealed in ops.settings).
export async function telegramChats(): Promise<ActionResult<{ chats: { id: string; label: string }[] }>> {
  return runGuarded("owner", async (member) => {
    const token = notifyEnv().telegramToken;
    if (!token) return { ok: false, error: ENV_COPY.notSet("TELEGRAM_BOT_TOKEN") };
    const q = await quota(member, LIMITS.alertWrite);
    if (q) return q;
    if (await webhookOn()) {
      const chats = (await readSeenChats()).map((c) => ({ id: c.id, label: c.label }));
      return { ok: true, data: { chats }, message: chats.length ? undefined : "No chats seen since the approval buttons were turned on. Send /start to your bot (in a group: /start@YourBot), then try again." };
    }
    const r = await findChats(token);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, data: { chats: r.chats }, message: r.chats.length ? undefined : "No chats yet. Send /start to your bot in Telegram, then try again." };
  }, deps);
}

export async function saveTelegram(chatId: string, label: string): Promise<ActionResult> {
  return runGuarded("owner", async (member) => {
    if (typeof chatId !== "string" || !/^-?\d{1,20}$/.test(chatId)) return { ok: false, error: "Check the highlighted fields.", fieldErrors: { chat: "Press Find chats, then pick one." } };
    if (!notifyEnv().telegramToken) return { ok: false, error: ENV_COPY.notSet("TELEGRAM_BOT_TOKEN") };
    const q = await quota(member, LIMITS.alertWrite);
    if (q) return q;
    await writeChannel("telegram", { chatId, chatLabel: String(label ?? "").slice(0, 60) });
    await audit(member, "ok", "Telegram channel saved");
    refresh();
    return { ok: true, message: "Telegram saved. Send a test to check it." };
  }, deps);
}

export async function saveDiscord(url: string): Promise<ActionResult> {
  return runGuarded("owner", async (member) => {
    const problem = typeof url === "string" ? webhookProblem(url) : "Paste the whole webhook URL from Discord.";
    if (problem) return { ok: false, error: "Check the highlighted fields.", fieldErrors: { url: problem } };
    const q = await quota(member, LIMITS.alertWrite);
    if (q) return q;
    await writeChannel("discord", { url: url.trim() });
    await audit(member, "ok", "Discord channel saved");
    refresh();
    return { ok: true, message: "Discord saved. Send a test to check it." };
  }, deps);
}

// 1.2.3: a generic outgoing webhook (n8n and the like). The URL and the secret are sealed like every channel config.
export async function saveWebhook(url: string, secret: string): Promise<ActionResult> {
  return runGuarded("owner", async (member) => {
    const u = typeof url === "string" ? url.trim() : "";
    const s = typeof secret === "string" ? secret.trim() : "";
    const fieldErrors: Record<string, string> = {};
    const urlBad = webhookUrlProblem(u);
    if (urlBad) fieldErrors.url = urlBad;
    const secretBad = secretProblem(s);
    if (secretBad) fieldErrors.secret = secretBad;
    if (Object.keys(fieldErrors).length) return { ok: false, error: "Check the highlighted fields.", fieldErrors };
    const q = await quota(member, LIMITS.alertWrite);
    if (q) return q;
    await writeChannel("webhook", { url: u, secret: s });
    await audit(member, "ok", "Webhook channel saved");
    refresh();
    return { ok: true, message: "Webhook saved. Send a test to check it, then turn it on for the alert rules you want." };
  }, deps);
}

// 1.2.3: alerts by email through the owner's own mail server. The password is sealed like every channel config and
// never comes back to the page; a Change without a new password keeps the saved one.
export async function saveSmtp(input: { host: string; port: number; user: string; pass: string; from: string; to: string }): Promise<ActionResult> {
  return runGuarded("owner", async (member) => {
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const port = Number(input?.port);
    let pass = typeof input?.pass === "string" ? input.pass : "";
    if (!pass) pass = (await readChannel("smtp"))?.config.pass ?? "";
    const c = { host: str(input?.host).toLowerCase(), port, user: str(input?.user), pass, from: str(input?.from), to: str(input?.to) };
    const fieldErrors = smtpProblems(c);
    if (Object.keys(fieldErrors).length) return { ok: false, error: "Check the highlighted fields.", fieldErrors };
    const q = await quota(member, LIMITS.alertWrite);
    if (q) return q;
    await writeChannel("smtp", { ...c, port: port as 465 | 587 | 2525 });
    await audit(member, "ok", "Email (SMTP) channel saved");
    refresh();
    return { ok: true, message: "Email (SMTP) saved. Send a test to check it, then turn it on for the alert rules you want." };
  }, deps);
}

export async function saveDigest(to: string): Promise<ActionResult> {
  return runGuarded("owner", async (member) => {
    const email = typeof to === "string" ? to.trim() : "";
    if (!z.email().safeParse(email).success) return { ok: false, error: "Check the highlighted fields.", fieldErrors: { to: "Enter a valid email address." } };
    const q = await quota(member, LIMITS.alertWrite);
    if (q) return q;
    await writeChannel("email_digest", { to: email });
    await audit(member, "ok", "Daily email digest channel saved");
    refresh();
    return { ok: true, message: "Daily email digest saved. Send a test to check it." };
  }, deps);
}

export async function setChannelEnabled(kind: ChannelKind, enabled: boolean): Promise<ActionResult> {
  return runGuarded("owner", async (member) => {
    if (!(CHANNEL_KINDS as readonly string[]).includes(kind) || typeof enabled !== "boolean") return { ok: false, error: INVALID };
    const q = await quota(member, LIMITS.alertWrite);
    if (q) return q;
    if (!(await storeEnabled(kind, enabled))) return { ok: false, error: `${NAME[kind]} isn't connected yet.` };
    await audit(member, "ok", `${NAME[kind]} channel turned ${enabled ? "on" : "off"}`);
    refresh();
    return { ok: true, message: `${NAME[kind]} is ${enabled ? "on" : "off"}.` };
  }, deps, "local");
}

// Send test: one message that says so (Telegram, Discord) or the digest built from real data. 5 a member per 10 minutes.
export async function sendTest(kind: ChannelKind): Promise<ActionResult> {
  return runGuarded("owner", async (member) => {
    if (!(CHANNEL_KINDS as readonly string[]).includes(kind)) return { ok: false, error: INVALID };
    const q = await quota(member, LIMITS.notifyTest);
    if (q) return q;
    const r = await sendTestMessage(kind, new Date());
    await audit(member, r.ok ? "ok" : "err", `Test sent to ${NAME[kind]}`);
    refresh();
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, message: kind === "email_digest" ? "Test digest sent. It arrives within a minute." : `Test message sent to ${NAME[kind]}.` };
  }, deps);
}

// The language of what Watchbell sends to one channel (Telegram, Discord, the email digest). The web UI stays English.
const LANG_NAME: Record<NotifyChannel, string> = { telegram: "Telegram", discord: "Discord", email: "the email digest" };
const LANG_AUDIT: Record<NotifyChannel, string> = { telegram: "Telegram", discord: "Discord", email: "email" };
export async function setNotifyLanguage(channel: string, v: string): Promise<ActionResult> {
  return runGuarded("owner", async (member) => {
    if (!(NOTIFY_CHANNELS as readonly string[]).includes(channel) || (v !== "en" && v !== "id")) return { ok: false, error: INVALID };
    const ch = channel as NotifyChannel;
    const q = await quota(member, LIMITS.alertWrite);
    if (q) return q;
    // Not readNotifyLangs(): that one turns a failed read into English, and saving that would reset the other channels.
    const current = parseNotifyLangs(await readNotifyLangSetting());
    const before = current[ch];
    if (before === v) return { ok: true, message: "Nothing changed." };
    await saveNotifyLangs({ ...current, [ch]: v });
    await audit(member, "ok", `Settings: ${LANG_AUDIT[ch]} language ${before} → ${v}`);
    refresh();
    return { ok: true, message: `${LANG_NAME[ch][0].toUpperCase()}${LANG_NAME[ch].slice(1)} now gets messages in ${v === "id" ? "Bahasa Indonesia" : "English"}.` };
  }, deps, "local");
}
