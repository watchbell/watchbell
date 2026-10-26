"use client";

import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button, fieldClass } from "@/components/kit";
import { addManualModel, removeManualModel } from "@/private/ai/providers/actions";

// Models page, custom connections only: add a model id the server doesn't list in /models (the server action makes one
// tiny completion with it before saving), and remove one again.
export function AddModelIdForm({ providerId, providerName }: { providerId: string; providerName: string }) {
  const id = useId();
  const [value, setValue] = useState("");
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        const modelId = value.trim();
        if (!modelId) return;
        start(async () => {
          try {
            const r = await addManualModel(providerId, modelId);
            if (r.ok) { toast.success(r.message ?? "Added."); setValue(""); } else toast.error(r.error);
          } catch {
            toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
          }
        });
      }}
    >
      <label htmlFor={id} className="text-[13px] font-medium">Add model id · {providerName}</label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={id} name="modelId" value={value} onChange={(e) => setValue(e.target.value)} maxLength={120} autoComplete="off" spellCheck={false}
          placeholder="model id" aria-describedby={`${id}-hint`} disabled={pending}
          className={`${fieldClass} min-w-0 flex-1 font-mono text-[13px] sm:max-w-[320px]`}
        />
        <Button size="sm" type="submit" disabled={pending || value.trim() === ""}>{pending ? "Testing…" : "Add"}</Button>
      </div>
      <p id={`${id}-hint`} className="m-0 text-[12.5px] text-ink-faint">For ids the server doesn&apos;t list (for example a combo). Watchbell tests it once before saving.</p>
    </form>
  );
}

export function RemoveManualModelButton({ providerId, modelId, publicId }: { providerId: string; modelId: string; publicId: string }) {
  return (
    <ConfirmDialog
      trigger={<Button size="sm" variant="ghost">Remove</Button>}
      title={`Remove ${publicId}?`}
      body="Watchbell stops offering this model id. Calls for it answer 400 model_not_enabled. Nothing changes on your server."
      cta="Remove"
      danger
      onConfirm={async () => {
        const r = await removeManualModel(providerId, modelId);
        return { ok: r.ok, message: (r.ok ? r.message : r.error) ?? "" };
      }}
    />
  );
}
