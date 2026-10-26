"use client";

import { IconKey } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button, Field, fieldClass } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { deleteMetricsKey, setMetricsKey } from "./metrics-actions";

// Stage 12: Add / Replace / Remove the owner's per-project metrics key. The key field is a password input that is
// cleared on every open and after a save; the page never receives a stored key back.

type Props = { id: string; projectRef: string; alias: string; hasKey: boolean };

export function MetricsKeyDialog({ id, projectRef, alias, hasKey, open, onOpenChange, trigger }: Props & {
  open?: boolean; onOpenChange?: (open: boolean) => void; trigger?: React.ReactElement;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const isOpen = open ?? ownOpen;
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, start] = useTransition();
  useHoldRefresh(isOpen);

  function show(next: boolean) {
    if (pending) return;
    setKey("");
    setError(undefined);
    if (open === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  }

  function save() {
    start(async () => {
      try {
        const r = await setMetricsKey(id, projectRef, key);
        if (!r.ok) {
          setError(r.fieldErrors?.key ?? r.error);
          toast.error(r.error);
          return;
        }
        // The server's sentence names the real project; the toast uses the alias (privacy).
        const failed = r.message?.includes("test call failed");
        toast.success(`Metrics key saved for ${alias}`, { description: failed ? "The test call failed; the Compute panel shows why." : "CPU shows after the next scrape, in about 5 minutes." });
        setKey("");
        show(false);
      } catch {
        toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
      }
    });
  }

  return (
    <Dialog open={isOpen} onOpenChange={show}>
      {trigger && <DialogTrigger render={trigger} />}
      <DialogContent className="gap-0 p-0 sm:max-w-[560px]" showCloseButton={false}>
        <div className="flex items-start gap-3 px-[18px] pb-2 pt-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft"><IconKey size={19} /></span>
          <div>
            <DialogTitle className="text-base">{hasKey ? "Replace" : "Add"} metrics key for {alias}</DialogTitle>
            <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">
              CPU, RAM, disk and connections come from Supabase&apos;s Metrics API (beta), which needs a Secret API key of this project.
            </DialogDescription>
          </div>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); save(); }}>
          <div className="px-[18px] pt-2 text-[13px] text-ink-soft">
            <ol className="mb-3 list-decimal space-y-1 pl-5">
              <li>In Supabase, open <b className="font-medium text-ink">Project Settings → API Keys</b> for this project and create a new Secret API key named <span className="font-mono text-ink">watchbell-metrics</span>.</li>
              <li>Paste it below. A secret key has full database power, so the console stores it encrypted, never shows it again and only sends it to this project&apos;s metrics endpoint.</li>
              <li>You can revoke it in Supabase at any time; the panel then shows the error and you can add a new one.</li>
            </ol>
            <Field id={`mk-${id}`} label="Secret API key" error={error} help="Starts with sb_secret_. Saving makes one test call to the metrics endpoint.">
              <input id={`mk-${id}`} type="password" className={`${fieldClass} font-mono`} autoComplete="off" spellCheck={false}
                placeholder="sb_secret_…" value={key} onChange={(e) => { setKey(e.target.value); setError(undefined); }} />
            </Field>
          </div>
          <div className="flex justify-end gap-2 border-t border-line px-[18px] py-3">
            <Button type="button" onClick={() => show(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={pending || !key.trim()}>{pending ? "Testing…" : hasKey ? "Replace key" : "Save key"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MetricsKeyButtons({ id, projectRef, alias, hasKey }: Props) {
  return (
    <span className="inline-flex gap-1.5">
      <MetricsKeyDialog id={id} projectRef={projectRef} alias={alias} hasKey={hasKey} trigger={<Button size="sm">{hasKey ? "Replace key" : "Add metrics key"}</Button>} />
      {hasKey && (
        <ConfirmDialog
          trigger={<Button size="sm" variant="ghost">Remove</Button>} danger title={`Remove the metrics key of ${alias}?`} cta="Remove key"
          body="The console deletes the stored key and this project's compute history. Revoke the key in Supabase (Project Settings → API Keys) too."
          onConfirm={async () => {
            const r = await deleteMetricsKey(id);
            return r.ok ? { ok: true, message: `Metrics key removed for ${alias}.` } : { ok: false, message: r.error };
          }}
        />
      )}
    </span>
  );
}
