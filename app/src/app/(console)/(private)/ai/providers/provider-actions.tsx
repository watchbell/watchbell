"use client";

import { IconPlugConnected } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button, fieldClass } from "@/components/kit";
import { RowMenu } from "@/components/row-menu";
import { makeDefaultProvider, removeProvider, setProviderEnabled, testProvider } from "@/private/ai/providers/actions";

function say(r: { ok: boolean; message?: string; error?: string }): void {
  if (r.ok) toast.success(r.message ?? "Done.");
  else toast.error(r.error ?? "Something went wrong.");
}

export function TestProviderButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <Button size="sm" disabled={pending} onClick={() => start(async () => say(await testProvider(id)))}>
      <IconPlugConnected size={15} aria-hidden />{pending ? "Testing…" : "Test"}
    </Button>
  );
}

// The mockup's switch: a checkbox styled as a toggle. Takes effect on the next request (60 s cache on other instances).
export function EnabledSwitch({ id, on, name }: { id: string; on: boolean; name: string }) {
  const [pending, start] = useTransition();
  const [value, setValue] = useState(on);
  return (
    <label className="relative inline-flex cursor-pointer items-center" title={`${name}: ${value ? "on" : "off"}`}>
      <input
        type="checkbox" role="switch" className="peer sr-only" checked={value} disabled={pending} aria-label={`${name} enabled`}
        onChange={(e) => {
          const next = e.target.checked;
          setValue(next);
          start(async () => {
            const r = await setProviderEnabled(id, next);
            if (!r.ok) setValue(!next);
            say(r);
          });
        }}
      />
      <span className="h-5 w-9 rounded-full bg-line-strong transition-colors peer-checked:bg-brand peer-focus-visible:ring-2 peer-focus-visible:ring-brand/40 peer-disabled:opacity-60" />
      <span className="absolute left-0.5 top-0.5 size-4 rounded-full bg-surface transition-transform peer-checked:translate-x-4" />
    </label>
  );
}

export function ProviderMenu({ id, name, isDefault }: { id: string; name: string; isDefault: boolean }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <RowMenu
        label={`Actions for ${name}`}
        items={[
          ...(isDefault ? [] : [{ label: "Make default", onSelect: async () => say(await makeDefaultProvider(id)) }, "---" as const]),
          { label: "Remove", danger: true, onSelect: () => setConfirm(true) },
        ]}
      />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Remove ${name}?`}
        body="Its encrypted key is deleted. Calls for its models answer 503 until you connect a provider again. Nothing changes at the provider."
        cta="Remove"
        danger
        onConfirm={async () => {
          const r = await removeProvider(id);
          return { ok: r.ok, message: (r.ok ? r.message : r.error) ?? "" };
        }}
      />
    </>
  );
}

export function DefaultProviderSelect({ options, current }: { options: { id: string; name: string }[]; current: string | null }) {
  const [pending, start] = useTransition();
  const [value, setValue] = useState(current ?? "");
  if (options.length === 0) return <span className="text-ink-faint">No provider connected</span>;
  return (
    <select
      aria-label="Default provider" className={`${fieldClass} w-auto`} value={value} disabled={pending}
      onChange={(e) => {
        const next = e.target.value;
        setValue(next);
        if (next) start(async () => say(await makeDefaultProvider(next)));
      }}
    >
      {!current && <option value="">None yet</option>}
      {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
}
