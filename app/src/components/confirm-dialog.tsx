"use client";

import { IconAlertTriangle, IconHelpCircle } from "@tabler/icons-react";
import { isValidElement, type ReactNode, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

// With `trigger`, the dialog owns its open state. Without one, the caller opens it (`open` / `onOpenChange`), for
// example from a row menu. While it is open the page's 60 s refresh waits. Esc and the scrim do nothing while the
// action runs, so the hold is not released under it.
export function ConfirmDialog({
  trigger, open: controlledOpen, onOpenChange, title, body, cta, danger = false, onConfirm,
}: {
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  body: ReactNode;
  cta: string;
  danger?: boolean;
  onConfirm: () => Promise<{ ok: boolean; message: string }>;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const [pending, start] = useTransition();
  useHoldRefresh(open);

  function setOpen(next: boolean) {
    if (controlledOpen === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  }

  function confirm() {
    start(async () => {
      try {
        const result = await onConfirm();
        if (result.ok) {
          toast.success(result.message);
          setOpen(false);
        } else {
          toast.error(result.message);
        }
      } catch {
        toast.error("Something went wrong. Try again.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) setOpen(next); }}>
      {/* Base UI's Trigger renders its own <button>. When the caller passes an element
          (usually a <Button>), render that element as the trigger so we never nest buttons. */}
      {trigger !== undefined && (isValidElement(trigger) ? <DialogTrigger render={trigger} /> : <DialogTrigger>{trigger}</DialogTrigger>)}
      <DialogContent className="gap-0 p-0 sm:max-w-[640px]" showCloseButton={false}>
        <div className="flex items-start gap-3 px-[18px] pb-2 pt-4">
          <span className={`grid size-9 shrink-0 place-items-center rounded-lg bg-sunken ${danger ? "text-err" : "text-ink-soft"}`}>
            {danger ? <IconAlertTriangle size={19} /> : <IconHelpCircle size={19} />}
          </span>
          <div>
            <DialogTitle className="text-base">{title}</DialogTitle>
            <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">{body}</DialogDescription>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-[18px] py-3">
          <Button onClick={() => setOpen(false)} disabled={pending}>Keep as is</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={confirm} disabled={pending}>
            {pending ? "Working…" : cta}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
