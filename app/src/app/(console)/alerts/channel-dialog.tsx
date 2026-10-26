"use client";

import { IconBrandDiscord, IconBrandTelegram, IconMail, IconWebhook } from "@tabler/icons-react";
import { ENV_COPY } from "@/lib/copy/edition";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import type { ChannelKind } from "@/db/schema";
import { Button, Field, fieldClass } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { saveDigest, saveDiscord, saveSmtp, saveTelegram, saveWebhook, sendTest, setChannelEnabled, telegramChats } from "./channel-actions";

// Mockup channelDlg(). The texts are the mockup's. Secrets typed here go to a server action and are never shown again:
// the page only ever gets a masked hint back.
const DIALOG = {
  telegram: { icon: IconBrandTelegram, title: "Connect Telegram", name: "Telegram", about: `The bot token is ${ENV_COPY.setting} (TELEGRAM_BOT_TOKEN). Here you only choose the chat.` },
  discord: { icon: IconBrandDiscord, title: "Connect Discord", name: "Discord", about: "Discord → Channel settings → Integrations → Webhooks → New webhook → Copy URL." },
  webhook: { icon: IconWebhook, title: "Connect a webhook", name: "Webhook", about: "Watchbell POSTs JSON to this address for every alert message. It must be https on a public host (port 443); Watchbell doesn't post into private networks or follow redirects." },
  smtp: { icon: IconMail, title: "Email through your mail server", name: "Email (SMTP)", about: "Port 587 or 2525 with STARTTLS, or 465 with TLS; the password only ever goes over TLS. The server must be on the public internet. Office 365: smtp.office365.com, 587, and an app password if your account has MFA." },
  email_digest: { icon: IconMail, title: "Daily email digest", name: "Daily email digest", about: `Sent through Resend from the address in DIGEST_FROM. The API key is ${ENV_COPY.setting} (RESEND_API_KEY).` },
} as const;

const NAME: Record<ChannelKind, string> = { telegram: "Telegram", discord: "Discord", webhook: "Webhook", smtp: "Email (SMTP)", email_digest: "Daily email digest" };

type Chat = { id: string; label: string };

// Connect or Change, Send test and Turn off/on for one channel. Owners only: the page renders nothing for anyone else,
// and every action refuses them anyway.
export function ChannelControls({ kind, connected, enabled, envMissing }: { kind: ChannelKind; connected: boolean; enabled: boolean; envMissing: string | null }) {
  const [open, setOpen] = useState(false);
  const [chats, setChats] = useState<Chat[]>([]);
  const [chat, setChat] = useState("");
  const [url, setUrl] = useState("");
  const [to, setTo] = useState("");
  const [secret, setSecret] = useState("");
  const [mail, setMail] = useState({ host: "", port: "587", user: "", pass: "", from: "", to: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, startSave] = useTransition();
  const [finding, startFind] = useTransition();
  const [busy, startBusy] = useTransition();
  useHoldRefresh(open);
  const d = DIALOG[kind];
  const Icon = d.icon;

  function show(next: boolean) {
    if (next) {
      setChats([]);
      setChat("");
      setUrl("");
      setTo("");
      setSecret("");
      setMail({ host: "", port: "587", user: "", pass: "", from: "", to: "" });
      setErrors({});
    }
    setOpen(next);
  }

  function save() {
    const local: Record<string, string> = {};
    if (kind === "telegram" && !chat) local.chat = "Press Find chats, then pick one.";
    if (kind === "discord" && !url.trim()) local.url = "Paste the whole webhook URL from Discord.";
    if (kind === "webhook" && !url.trim()) local.url = "Paste the whole address, starting with https://.";
    if (kind === "smtp" && !mail.host.trim()) local.host = "Enter the server name, for example smtp.office365.com.";
    if (kind === "smtp" && !mail.to.trim()) local.to = "Enter the address that gets the alerts.";
    if (kind === "email_digest" && !to.trim()) local.to = "Enter a valid email address.";
    setErrors(local);
    if (Object.keys(local).length) return;
    startSave(async () => {
      try {
        const label = chats.find((c) => c.id === chat)?.label ?? "";
        const r = kind === "telegram" ? await saveTelegram(chat, label) : kind === "discord" ? await saveDiscord(url) : kind === "webhook" ? await saveWebhook(url, secret)
          : kind === "smtp" ? await saveSmtp({ ...mail, port: Number(mail.port) }) : await saveDigest(to);
        if (!r.ok) {
          setErrors(r.fieldErrors ?? {});
          if (!r.fieldErrors) toast.error(r.error);
          return;
        }
        toast.success("Channel saved", { description: r.message });
        setOpen(false);
      } catch {
        toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
      }
    });
  }

  function find() {
    startFind(async () => {
      try {
        const r = await telegramChats();
        if (!r.ok) {
          toast.error(r.error);
          return;
        }
        const found = r.data?.chats ?? [];
        setChats(found);
        setChat(found[0]?.id ?? "");
        setErrors({});
        if (found.length) toast.success(`Found ${found.length} chat${found.length === 1 ? "" : "s"}: ${found.map((c) => c.label).join(", ")}.`);
        else toast.info("No chats yet", { description: r.message ?? "Send /start to your bot in Telegram, then try again." });
      } catch {
        toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
      }
    });
  }

  function run(job: () => ReturnType<typeof sendTest>, title: string) {
    startBusy(async () => {
      try {
        const r = await job();
        if (r.ok) toast.success(title, { description: r.message });
        else toast.error(r.error);
      } catch {
        toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
      }
    });
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {/* Esc and the scrim do nothing while the save runs. */}
      <Dialog open={open} onOpenChange={(next) => { if (!saving) show(next); }}>
        <DialogTrigger render={<Button size="sm" disabled={envMissing !== null}>{connected ? "Change" : "Connect"}</Button>} />
        <DialogContent className="gap-0 p-0 sm:max-w-[560px]" showCloseButton={false}>
          <div className="flex items-start gap-3 px-[18px] pb-2 pt-4">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft"><Icon size={19} /></span>
            <div>
              <DialogTitle className="text-base">{d.title}</DialogTitle>
              <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">{d.about}</DialogDescription>
            </div>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); save(); }}>
            <div className="px-[18px] pt-2">
              {kind === "telegram" && (
                <>
                  <Field id="ch-chat" label="Chat" help="Send /start to your bot in Telegram first." error={errors.chat}>
                    <select id="ch-chat" className={fieldClass} value={chat} onChange={(e) => setChat(e.target.value)}>
                      {chats.length === 0 && <option value="">Press Find chats after you message the bot</option>}
                      {chats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                  </Field>
                  <p className="mb-3"><Button size="sm" onClick={find} disabled={finding}>{finding ? "Looking…" : "Find chats"}</Button></p>
                </>
              )}
              {kind === "discord" && (
                <Field id="ch-hook" label="Webhook URL" help="Encrypted before it's saved and never shown again." error={errors.url}>
                  <input id="ch-hook" className={fieldClass} type="password" autoComplete="off" placeholder="https://discord.com/api/webhooks/…" value={url} onChange={(e) => setUrl(e.target.value)} />
                </Field>
              )}
              {kind === "webhook" && (
                <>
                  <Field id="ch-wh" label="Address" help="Encrypted before it's saved and never shown again; the console shows only its host." error={errors.url}>
                    <input id="ch-wh" className={fieldClass} type="url" autoComplete="off" placeholder="https://n8n.example.com/webhook/…" value={url} onChange={(e) => setUrl(e.target.value)} />
                  </Field>
                  <Field id="ch-wh-secret" label="Secret (optional)" help="16 to 200 characters. Each body is signed with it: header X-Watchbell-Signature = sha256 HMAC of the timestamp, a dot and the body." error={errors.secret}>
                    <input id="ch-wh-secret" className={fieldClass} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
                  </Field>
                </>
              )}
              {kind === "smtp" && (
                <div className="grid grid-cols-2 gap-x-3 max-[520px]:grid-cols-1">
                  <Field id="ch-sm-host" label="Server" error={errors.host}>
                    <input id="ch-sm-host" className={fieldClass} autoComplete="off" placeholder="smtp.office365.com" value={mail.host} onChange={(e) => setMail({ ...mail, host: e.target.value })} />
                  </Field>
                  <Field id="ch-sm-port" label="Port" error={errors.port}>
                    <select id="ch-sm-port" className={fieldClass} value={mail.port} onChange={(e) => setMail({ ...mail, port: e.target.value })}>
                      <option value="587">587 · STARTTLS</option>
                      <option value="465">465 · TLS</option>
                      <option value="2525">2525 · STARTTLS</option>
                    </select>
                  </Field>
                  <Field id="ch-sm-user" label="User name" error={errors.user}>
                    <input id="ch-sm-user" className={fieldClass} autoComplete="off" value={mail.user} onChange={(e) => setMail({ ...mail, user: e.target.value })} />
                  </Field>
                  <Field id="ch-sm-pass" label="Password" help={connected ? "Leave empty to keep the saved one." : "Encrypted before it's saved and never shown again."} error={errors.pass}>
                    <input id="ch-sm-pass" className={fieldClass} type="password" autoComplete="off" value={mail.pass} onChange={(e) => setMail({ ...mail, pass: e.target.value })} />
                  </Field>
                  <Field id="ch-sm-from" label="From" error={errors.from}>
                    <input id="ch-sm-from" className={fieldClass} type="email" autoComplete="off" placeholder="alerts@example.com" value={mail.from} onChange={(e) => setMail({ ...mail, from: e.target.value })} />
                  </Field>
                  <Field id="ch-sm-to" label="Send to" error={errors.to}>
                    <input id="ch-sm-to" className={fieldClass} type="email" autoComplete="off" placeholder="you@example.com" value={mail.to} onChange={(e) => setMail({ ...mail, to: e.target.value })} />
                  </Field>
                </div>
              )}
              {kind === "email_digest" && (
                <Field id="ch-to" label="Send to" error={errors.to}>
                  <input id="ch-to" className={fieldClass} type="email" autoComplete="off" placeholder="name@example.com" value={to} onChange={(e) => setTo(e.target.value)} />
                </Field>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-[18px] py-3">
              <Button onClick={() => show(false)} disabled={saving}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      {connected && enabled && envMissing === null && (
        <Button size="sm" disabled={busy} onClick={() => run(() => sendTest(kind), `${NAME[kind]} test`)}>{busy ? "Sending…" : "Send test"}</Button>
      )}
      {connected && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => setChannelEnabled(kind, !enabled), NAME[kind])}>
          {enabled ? "Turn off" : "Turn on"}
        </Button>
      )}
    </span>
  );
}
