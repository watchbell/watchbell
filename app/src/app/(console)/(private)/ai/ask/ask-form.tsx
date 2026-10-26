"use client";

import { IconSend } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button, fieldClass } from "@/components/kit";
import { ASK_COPY } from "@/lib/copy/edition";
import { cn } from "@/lib/utils";
import { askGeneral } from "@/private/assist/actions";
import { Thinking } from "@/private/slots/thinking";

// AI › Ask (mockup AI_VIEWS.ask): the question box. The Server Action checks everything again (owner, 1–2000
// characters, no keys or tokens, quota, the model is switched on); this only counts characters and clears the box once
// it is answered or sent. `models`: the provider models that are on, then (only while Antigravity is connected) its
// ag/ models. Default = the default provider's default model. A provider answers in the same request, so "Thinking… N s"
// shows while it runs (a router combo can take ~25 s).
const MAX = 2000;

export function AskForm({ models = [], defaultLabel = "your provider" }: { models?: { id: string; label: string }[]; defaultLabel?: string }) {
  const [text, setText] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const send = () => {
    if (!text.trim() || pending) return;
    setError(null);
    start(async () => {
      try {
        const r = await askGeneral(text, model || null);
        if (r.ok) {
          setText("");
          toast.success(r.message ?? "Sent.");
        } else setError(r.error);
      } catch {
        setError("Watchbell didn't answer. Check that it's still running, then try again.");
      }
    });
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); send(); }}>
      <label htmlFor="ask-in" className="mb-1.5 block font-medium">Ask about your apps, alerts, deployments or databases</label>
      <textarea
        id="ask-in"
        className={cn(fieldClass, "min-h-22 w-full")}
        placeholder="For example: which apps need attention before the weekend?"
        value={text}
        maxLength={MAX}
        aria-describedby="ask-hint ask-count"
        aria-invalid={error ? true : undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }}
      />
      {error && <p role="alert" className="mt-1.5 text-[13px] text-err">{error}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span id="ask-hint" className="min-w-[220px] flex-1 text-[12.5px] text-ink-faint">
          {pending ? <Thinking /> : ASK_COPY.hint}
        </span>
        <span id="ask-count" className="font-mono text-[12px] text-ink-faint" aria-live="off">{text.length} / {MAX}</span>
        {models.length > 0 && (
          <label className="flex items-center gap-1.5 text-[13px] text-ink-soft">
            <span className="sr-only">Model</span>
            <select className={cn(fieldClass, "max-w-[260px] py-1 font-mono text-[12.5px]")} value={model} onChange={(e) => setModel(e.target.value)} disabled={pending}>
              <option value="">Default ({defaultLabel})</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
        )}
        <Button type="submit" variant="primary" disabled={pending || !text.trim()}>
          <IconSend size={16} aria-hidden />{pending ? "Asking…" : "Send"}
        </Button>
      </div>
    </form>
  );
}
