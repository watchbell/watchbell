"use client";

import { IconBrandDiscord, IconBrandTelegram, IconMail } from "@tabler/icons-react";
import { ENV_COPY } from "@/lib/copy/edition";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import type { ChannelKind } from "@/db/schema";
import { Button, Field, fieldClass } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { saveDigest, saveDiscord, saveTelegram, sendTest, setChannelEnabled, telegramChats } from "./channel-actions";

// Mockup channelDlg(). The texts are the mockup's. Secrets typed here go to a server action and are never shown again:
// the page only ever gets a masked hint back.
const DIALOG = {
  telegram: { icon: IconBrandTelegram, title: "Connect Telegram", name: "Telegram", about: `The bot token is ${ENV_COPY.setting} (TELEGRAM_BOT_TOKEN). Here you only choose the chat.` },
  discord: { icon: IconBrandDiscord, title: "Connect Discord", name: "Discord", about: "Discord → Channel settings → Integrations → Webhooks → New webhook → Copy URL." },
  email_digest: { icon: IconMail, title: "Daily email digest", name: "Daily email digest", about: `Sent through Resend from the address in DIGEST_FROM. The API key is ${ENV_COPY.setting} (RESEND_API_KEY).` },
} as const;

const NAME: Record<ChannelKind, string> = { telegram: "Telegram", discord: "Discord", email_digest: "Daily email digest" };

type Chat = { id: string; label: string };

// Connect or Change, Send test and Turn off/on for one channel. Owners only: the page renders nothing for anyone else,
// and every action refuses them anyway.
export function ChannelControls({ kind, connected, enabled, envMissing }: { kind: ChannelKind; connected: boolean; enabled: boolean; envMissing: string | null }) {
  const [open, setOpen] = useState(false);
  const [chats, setChats] = useState<Chat[]>([]);
  const [chat, setChat] = useState("");
  const [url, setUrl] = useState("");
  const [to, setTo] = useState("");
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
      setErrors({});
    }
    setOpen(next);
  }

  function save() {
    const local: Record<string, string> = {};
    if (kind === "telegram" && !chat) local.chat = "Press Find chats, then pick one.";
    if (kind === "discord" && !url.trim()) local.url = "Paste the whole webhook URL from Discord.";
    if (kind === "email_digest" && !to.trim()) local.to = "Enter a valid email address.";
    setErrors(local);
    if (Object.keys(local).length) return;
    startSave(async () => {
      try {
        const label = chats.find((c) => c.id === chat)?.label ?? "";
        const r = kind === "telegram" ? await saveTelegram(chat, label) : kind === "discord" ? await saveDiscord(url) : await saveDigest(to);
        if (!r.ok) {
          setErrors(r.fieldErrors ?? {});
          if (!r.fieldErrors) toast.error(r.error);
          return;
        }
        toast.success("Channel saved", { description: r.message });
        setOpen(false);
      } catch {
        toast.error("Something went wrong. Try again.");
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
        toast.error("Something went wrong. Try again.");
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
        toast.error("Something went wrong. Try again.");
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
