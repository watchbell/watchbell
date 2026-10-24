"use client";

import { IconBolt, IconBrandGithub, IconCloud, IconDatabase, IconExternalLink, IconFlame, IconPlus, IconTriangle } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useMask } from "@/components/alias";
import { Button, buttonClass, Field, fieldClass } from "@/components/kit";
import { Status } from "@/components/status";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { Provider } from "@/lib/providers/info";
import { PROVIDER_INFO } from "@/lib/providers/info";
import type { TestResult } from "@/lib/providers/test-connection";
import { addAccount, checkCredential, replaceCredential } from "./actions";

export const PROVIDER_ICONS = { triangle: IconTriangle, bolt: IconBolt, database: IconDatabase, flame: IconFlame, cloud: IconCloud, github: IconBrandGithub };

// The credential form (spec §7): account name, the credential, "Create one ↗" (or "How to create one ↗" for a
// self-hosted tool's official guide), "It needs", Test connection (never saves) and Save (which tests first). Used
// inline in the provider drawer to add an account, and in the Replace credential dialog.
export function AccountForm({
  provider, replace, onDone, onCancel,
}: { provider: Provider; replace?: { id: string; label: string }; onDone?: () => void; onCancel?: () => void }) {
  const info = PROVIDER_INFO[provider];
  const [pending, start] = useTransition();
  const [label, setLabel] = useState("");
  const [credential, setCredential] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<TestResult | null>(null);
  const idp = `${provider}-${replace?.id ?? "new"}`;

  function test() {
    start(async () => {
      const r = await checkCredential(provider, credential);
      setErrors(r.ok ? {} : r.fieldErrors ?? {});
      setResult(r.ok ? r.data ?? null : r.fieldErrors ? null : { ok: false, kind: "transient", error: r.error });
    });
  }

  function save() {
    start(async () => {
      const r = replace ? await replaceCredential(replace.id, credential) : await addAccount(provider, label, credential);
      setErrors(r.ok ? {} : r.fieldErrors ?? {});
      if (r.data) setResult(r.data);
      if (r.ok) {
        toast.success(r.message);
        setLabel("");
        setCredential("");
        setResult(null);
        onDone?.();
      } else if (!r.fieldErrors && !r.data) {
        toast.error(r.error);
      }
    });
  }

  const kind = info.credentialKind.toLowerCase();
  return (
    <>
      <div className="px-[18px] pt-1.5">
        {!replace && (
          <Field id={`${idp}-name`} label="Account name" help="Shown next to everything that comes from this account." error={errors.label}>
            <input id={`${idp}-name`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={provider === "vercel" ? "acme" : "utama"} className={fieldClass} />
          </Field>
        )}
        <Field
          id={`${idp}-cred`}
          label={info.credentialKind}
          error={errors.credential}
          help={<a href={info.createUrl} target="_blank" rel="noopener noreferrer">{info.guide ? "How to create one" : "Create one"} <IconExternalLink size={12} className="inline" /></a>}
        >
          {info.json ? (
            <textarea id={`${idp}-cred`} spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off" data-gramm="false" value={credential} onChange={(e) => setCredential(e.target.value)} className={`${fieldClass} min-h-24 font-mono text-[12.5px]`} placeholder='{ "type": "service_account", "client_email": "…", "private_key": "…" }' />
          ) : (
            <input id={`${idp}-cred`} type="password" spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off" data-gramm="false" value={credential} onChange={(e) => setCredential(e.target.value)} className={fieldClass} placeholder={`Paste the ${kind}`} />
          )}
        </Field>
        <div className="mb-3.5 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[13px]">
          <b className="font-medium">It needs</b>
          <ul className="mt-1 list-disc pl-[18px] text-ink-soft">{info.needs.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
        {result && (
          <div className={`mb-3.5 rounded-lg px-3 py-2.5 text-[13px] ${result.ok ? "bg-ok-soft" : "bg-err-soft"}`} role="status">
            <Status state={result.ok ? "ok" : "err"}>{result.ok ? "Connected" : "Couldn't connect"}</Status>
            <ul className="mt-1 list-disc pl-[18px]">{result.ok ? [result.summary, ...result.details].map((d) => <li key={d}>{d}</li>) : <li>{result.error}</li>}</ul>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-[18px] py-3">
        <span className="mr-auto text-[12.5px] text-ink-faint">Save tests the credential first.</span>
        <Button onClick={test} disabled={pending}>Test connection</Button>
        {onCancel && <Button onClick={onCancel} disabled={pending}>Cancel</Button>}
        <Button variant="primary" onClick={save} disabled={pending}>{pending ? "Working…" : "Save"}</Button>
      </div>
    </>
  );
}

// The same form in a dialog: Replace credential (from an account in the provider drawer) and the Welcome page's
// Connect buttons.
export function AccountDialog({
  provider, replace, triggerLabel, primary,
}: { provider: Provider; replace?: { id: string; label: string }; triggerLabel?: string; primary?: boolean }) {
  const info = PROVIDER_INFO[provider];
  const Icon = PROVIDER_ICONS[info.icon];
  const [open, setOpen] = useState(false);
  // A fresh form each time the dialog opens (the key changes), so a closed dialog keeps no pasted credential.
  const [round, setRound] = useState(0);
  const mask = useMask();

  function change(next: boolean) {
    setOpen(next);
    if (!next) setRound((n) => n + 1);
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger className={buttonClass({ size: "sm", variant: primary ? "primary" : "secondary" })}>
        {!replace && !triggerLabel && <IconPlus size={16} />}
        {triggerLabel ?? (replace ? "Replace credential" : "Add account")}
      </DialogTrigger>
      <DialogContent className="max-w-[640px] gap-0 p-0 sm:max-w-[640px]">
        <div className="flex items-start gap-3 px-[18px] pb-2 pt-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft"><Icon size={19} /></span>
          <div>
            <DialogTitle className="text-base">{replace ? `Replace credential · ${info.name} · ${mask("account", replace.label)}` : `Connect ${info.name}`}</DialogTitle>
            <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">
              {replace ? "The old credential is deleted as soon as the new one works." : "The credential is encrypted before it's saved and never shown again."}
            </DialogDescription>
          </div>
        </div>
        <AccountForm key={round} provider={provider} replace={replace} onDone={() => change(false)} onCancel={() => change(false)} />
      </DialogContent>
    </Dialog>
  );
}
