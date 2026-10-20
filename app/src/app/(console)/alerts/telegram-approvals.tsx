"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/kit";
import { type ApprovalsView, approvalsStatus, disableApprovals, enableApprovals, telegramLinkCode } from "./telegram-approvals-actions";

// Stage 9 slice 7: the approval buttons under the Telegram channel (Owners only; the page renders it for nobody else and
// every action refuses anyone else). The status is read once when the tab shows it: one getWebhookInfo call while on.
export function TelegramApprovals() {
  const [v, setV] = useState<ApprovalsView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, start] = useTransition();

  useEffect(() => {
    let live = true;
    approvalsStatus().then((r) => {
      if (!live) return;
      if (r.ok && r.data) setV(r.data);
      else setFailed(r.ok ? null : r.error);
    }).catch(() => live && setFailed("Couldn't read the status."));
    return () => { live = false; };
  }, []);

  function run(job: () => Promise<{ ok: boolean; error?: string; message?: string; data?: ApprovalsView }>, after?: () => void) {
    start(async () => {
      try {
        const r = await job();
        if (!r.ok) {
          toast.error(r.error ?? "Something went wrong. Try again.");
          return;
        }
        if (r.data) setV(r.data);
        after?.();
        if (r.message) toast.success("Approval buttons", { description: r.message });
      } catch {
        toast.error("Something went wrong. Try again.");
      }
    });
  }

  function showCode() {
    start(async () => {
      try {
        const r = await telegramLinkCode();
        if (r.ok && r.data) setCode(r.data);
        else toast.error(r.ok ? "Something went wrong. Try again." : r.error);
      } catch {
        toast.error("Something went wrong. Try again.");
      }
    });
  }

  const state = !v ? (failed ?? "Checking…") : !v.on ? "Off" : v.linked ? "On · linked to your Telegram account" : "On · not linked yet";
  const until = code ? new Date(code.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

  return (
    <div className="mt-1 basis-full rounded-md border border-line px-3 py-2 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Approval buttons</span>
        <span className="text-ink-soft">{state}</span>
        <span className="ml-auto inline-flex flex-wrap gap-2">
          {v && !v.on && <Button size="sm" disabled={busy} onClick={() => run(enableApprovals)}>{busy ? "Working…" : "Turn on"}</Button>}
          {v?.on && <Button size="sm" disabled={busy} onClick={showCode}>{v.linked ? "Link again" : "Show link code"}</Button>}
          {v?.on && <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(disableApprovals, () => setCode(null))}>Turn off</Button>}
        </span>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-soft">
        Proposal notices get ✅ Approve / ❌ Reject buttons that only your linked Telegram account can use; risky actions ask twice.
        While this is on, Telegram sends updates to the console instead of holding them, so Find chats lists the chats the bot has seen since then.
      </p>
      {v?.problem && <p className="mt-1 text-[12.5px] text-err">{v.problem}</p>}
      {code && (
        <p className="mt-1 text-[12.5px]">
          Send <code className="rounded bg-sunken px-1 font-mono">/link {code.code}</code> in the connected chat before {until}. The code works once.
        </p>
      )}
    </div>
  );
}
