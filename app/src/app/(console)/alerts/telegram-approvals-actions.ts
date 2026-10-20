"use server";

import { type ActionResult, type GuardMember, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { ACTIONS_COPY, ENV_COPY } from "@/lib/copy/edition";
import { recordAction } from "@/lib/data/audit-db";
import { telegramTarget } from "@/lib/data/notify-db";
import { clearSeenChats, clearWebhookSecret, createLinkCode, ownerLinked, saveWebhookSecret, webhookOn } from "@/lib/data/telegram-bot-db";
import { serverEnv } from "@/lib/env";
import { mode, usesLocalAuth } from "@/lib/mode";
import { notifyEnv } from "@/lib/notify/env";
import { deleteWebhook, getWebhookInfo, newWebhookSecret, setWebhook, WEBHOOK_PATH } from "@/lib/notify/telegram-bot";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

// Stage 9 slice 7, Alerts → Notifications → Telegram (Owners only): the approval buttons on proposal notices. Turning
// them on generates a webhook secret (sealed in ops.settings) and points the bot's webhook at this console; turning them
// off deletes the webhook. The /link code ties the owner's Telegram account to the buttons. Audit rows never carry the
// secret, the code, a chat id or a Telegram user id.
const deps = { requireActionMember };

export type ApprovalsView = { on: boolean; linked: boolean; problem: string | null; pending: number };

const webhookUrl = () => `${serverEnv().SITE_URL.replace(/\/+$/, "")}${WEBHOOK_PATH}`;

async function quota(member: GuardMember): Promise<{ ok: false; error: string } | null> {
  const q = await limit(LIMITS.alertWrite, member.id);
  return q.allowed ? null : { ok: false, error: `Too many changes. Try again in ${minutesText(q.retryAfter)}.` };
}
async function audit(member: GuardMember, kind: "ok" | "err", message: string) {
  await recordAction({ kind, message, resourceId: null, actorUserId: member.userId }).catch(() => console.warn("audit event failed"));
}

async function view(token: string | null): Promise<ApprovalsView> {
  const [on, linked] = await Promise.all([webhookOn(), ownerLinked()]);
  // Selfhost polls Telegram instead of receiving a webhook, so there is no webhook to compare. The demo has no
  // webhook either (and must make no call to Telegram), so it takes the same path.
  if (usesLocalAuth()) return { on, linked, problem: on && !token ? "TELEGRAM_BOT_TOKEN isn't set." : null, pending: 0 };
  if (!on || !token) return { on, linked, problem: on && !token ? ENV_COPY.notSet("TELEGRAM_BOT_TOKEN") : null, pending: 0 };
  const r = await getWebhookInfo(token);
  if (!r.ok) return { on, linked, problem: r.error, pending: 0 };
  if (r.info.url !== webhookUrl()) return { on, linked, problem: "The bot's webhook points somewhere else. Turn the buttons off and on again.", pending: r.info.pending };
  const recent = r.info.lastErrorAt && Date.now() - r.info.lastErrorAt.getTime() < 86_400_000;
  return { on, linked, problem: r.info.lastError && recent ? `Telegram's last delivery failed: ${r.info.lastError}` : null, pending: r.info.pending };
}

export async function approvalsStatus(): Promise<ActionResult<ApprovalsView>> {
  return runGuarded("owner", async () => ({ ok: true, data: await view(notifyEnv().telegramToken) }), deps, "local");
}

export async function enableApprovals(): Promise<ActionResult<ApprovalsView>> {
  return runGuarded("owner", async (member) => {
    const token = notifyEnv().telegramToken;
    if (!token) return { ok: false, error: ENV_COPY.notSet("TELEGRAM_BOT_TOKEN") };
    if (!(await telegramTarget())) return { ok: false, error: "Connect Telegram and turn it on first." };
    const selfhost = mode() === "selfhost";
    if (!selfhost && !webhookUrl().startsWith("https://")) return { ok: false, error: "Telegram needs an https SITE_URL for its webhook." };
    const q = await quota(member);
    if (q) return q;
    if (selfhost) {
      // No public URL: the app polls Telegram. getUpdates only works with no webhook set, so remove any first; the
      // stored secret is what marks approvals as on (the poller reads it).
      const d = await deleteWebhook(token);
      if (!d.ok) {
        await audit(member, "err", "Telegram approval buttons couldn't be turned on");
        return { ok: false, error: d.error };
      }
      await saveWebhookSecret(newWebhookSecret(), new Date());
      await audit(member, "ok", "Telegram approval buttons turned on");
      return { ok: true, data: await view(token), message: "Approval buttons are on. Link your Telegram account next." };
    }
    // The secret is stored first, so Telegram's first delivery already finds it.
    const secret = newWebhookSecret();
    await saveWebhookSecret(secret, new Date());
    const r = await setWebhook(token, webhookUrl(), secret);
    if (!r.ok) {
      await clearWebhookSecret();
      await audit(member, "err", "Telegram approval buttons couldn't be turned on");
      return { ok: false, error: r.error };
    }
    await audit(member, "ok", "Telegram approval buttons turned on");
    return { ok: true, data: await view(token), message: "Approval buttons are on. Link your Telegram account next." };
  }, deps);
}

export async function disableApprovals(): Promise<ActionResult<ApprovalsView>> {
  return runGuarded("owner", async (member) => {
    const token = notifyEnv().telegramToken;
    const q = await quota(member);
    if (q) return q;
    if (token) {
      const r = await deleteWebhook(token);
      // Keep the secret while the webhook may still be set, so Telegram's deliveries keep authenticating.
      if (!r.ok) return { ok: false, error: r.error };
    }
    await clearWebhookSecret();
    await clearSeenChats();
    await audit(member, "ok", "Telegram approval buttons turned off");
    return { ok: true, data: { on: false, linked: await ownerLinked(), problem: null, pending: 0 }, message: ACTIONS_COPY.approvalsOff };
  }, deps);
}

// A one-time code, valid 10 minutes, shown to this owner only: send "/link CODE" in the connected chat.
export async function telegramLinkCode(): Promise<ActionResult<{ code: string; expiresAt: string }>> {
  return runGuarded("owner", async (member) => {
    if (!(await webhookOn())) return { ok: false, error: "Turn the approval buttons on first." };
    const q = await quota(member);
    if (q) return q;
    const { code, expiresAt } = await createLinkCode(member.id, new Date());
    await audit(member, "ok", "Telegram link code created");
    return { ok: true, data: { code, expiresAt: expiresAt.toISOString() } };
  }, deps);
}
