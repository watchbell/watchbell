"use client";

import { type ReactNode, useState } from "react";
import { useMask } from "@/components/alias";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/kit";
import type { ActionResult } from "@/lib/action";
import { confirmResult } from "@/lib/view/action-result";

// Stage 6 A3: every provider action is confirmed in a dialog that names the target (title) and the effect (body).
// The server action is passed in already bound to its ids, so this file never imports server-only code.
export type ProviderActionProps = {
  label: string;
  title: string;
  body: ReactNode;
  cta: string;
  danger?: boolean;
  run: () => Promise<ActionResult>;
};

// The toast is the server's sentence, which can name the app: screenshot mode masks it like the dialog's title.
function useAsConfirm() {
  const mask = useMask();
  return (r: ActionResult) => confirmResult(r, (t) => mask("text", t));
}

export function ProviderActionButton({ label, title, body, cta, danger = false, run }: ProviderActionProps) {
  const asConfirm = useAsConfirm();
  return (
    <ConfirmDialog
      trigger={<Button variant={danger ? "danger" : "secondary"}>{label}</Button>}
      title={title}
      body={body}
      cta={cta}
      danger={danger}
      onConfirm={async () => asConfirm(await run())}
    />
  );
}

// For RowMenu entries: `open(...)` from an item's onSelect, and render `dialog` once next to the menu.
export function useProviderAction(): { open: (p: Omit<ProviderActionProps, "label">) => void; dialog: ReactNode } {
  const [current, setCurrent] = useState<Omit<ProviderActionProps, "label"> | null>(null);
  const asConfirm = useAsConfirm();
  const dialog = current ? (
    <ConfirmDialog
      open
      onOpenChange={(next) => { if (!next) setCurrent(null); }}
      title={current.title}
      body={current.body}
      cta={current.cta}
      danger={current.danger}
      onConfirm={async () => asConfirm(await current.run())}
    />
  ) : null;
  return { open: setCurrent, dialog };
}
