"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button, Field, fieldClass } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { RowMenu } from "@/components/row-menu";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { forgetAgentAction, renameAgentAction } from "@/private/agents/actions";

function RenameForm({ id, current, detected, onDone }: { id: string; current: string; detected: string; onDone: () => void }) {
  const [name, setName] = useState(current === detected ? "" : current);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      setError("");
      try {
        const r = await renameAgentAction(id, name);
        if (r.ok) {
          toast.success(r.message ?? "Agent renamed.");
          onDone();
        } else setError(r.fieldErrors?.name ?? r.error);
      } catch {
        setError("Watchbell didn't answer. Check that it's still running, then try again.");
      }
    });
  }
  return (
    <form onSubmit={submit} noValidate>
      <div className="px-[18px] pb-2 pt-4">
        <DialogTitle className="text-base">Rename {detected}</DialogTitle>
        <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">Only changes what this page shows. Leave it empty to use the detected name again.</DialogDescription>
      </div>
      <div className="px-[18px] pt-1.5">
        <Field id="agent-name" label="Name" error={error}>
          <input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={detected} autoComplete="off" spellCheck={false} className={fieldClass} />
        </Field>
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-[18px] py-3">
        <Button onClick={onDone} disabled={pending}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Saving…" : "Save name"}</Button>
      </div>
    </form>
  );
}

// The row's kebab: Rename, Show logs, Forget. An agent whose key is revoked can only be shown in the logs or forgotten.
export function AgentActions({ id, name, clientName, keyRevoked }: { id: string; name: string; clientName: string; keyRevoked: boolean }) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  useHoldRefresh(renaming);
  return (
    <>
      <RowMenu
        label={`Actions for ${name}`}
        items={[
          ...(keyRevoked ? [] : [{ label: "Rename", onSelect: () => setRenaming(true) }]),
          { label: "Show logs", onSelect: () => router.push(`/ai/logs?agent=${encodeURIComponent(id)}`) },
          "---",
          { label: "Forget", danger: true, onSelect: () => setForgetting(true) },
        ]}
      />
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="gap-0 p-0 sm:max-w-[520px]" showCloseButton={false}>
          {renaming && <RenameForm id={id} current={name} detected={clientName} onDone={() => setRenaming(false)} />}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={forgetting}
        onOpenChange={setForgetting}
        title={`Forget ${name}?`}
        body="Removes it from this list. Its calls stay in the logs for 30 days. It appears again with its next request."
        cta="Forget agent"
        danger
        onConfirm={async () => {
          const r = await forgetAgentAction(id);
          return { ok: r.ok, message: (r.ok ? r.message : r.error) ?? "" };
        }}
      />
    </>
  );
}
