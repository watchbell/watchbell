"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { useMask } from "@/components/alias";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/kit";
import { removeAccount, retestAccount } from "./actions";

export function RetestButton({ accountId }: { accountId: string }) {
  const [pending, start] = useTransition();
  return (
    <Button size="sm" disabled={pending} onClick={() => start(async () => {
      const r = await retestAccount(accountId);
      if (r.ok) toast.success(r.message);
      else toast.error(r.error);
    })}>
      {pending ? "Testing…" : "Test connection"}
    </Button>
  );
}

export function RemoveAccountButton({ accountId, title }: { accountId: string; title: string }) {
  const mask = useMask();
  return (
    <ConfirmDialog
      trigger={<Button size="sm">Remove</Button>}
      title={`Remove ${mask("text", title)}?`}
      body="The console deletes its credential and stops watching its resources. Nothing changes at the provider."
      cta="Remove"
      danger
      onConfirm={async () => {
        const r = await removeAccount(accountId);
        return { ok: r.ok, message: (r.ok ? r.message : r.error) ?? "" };
      }}
    />
  );
}
