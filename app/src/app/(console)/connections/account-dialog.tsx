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

const ICONS = { triangle: IconTriangle, bolt: IconBolt, database: IconDatabase, flame: IconFlame, cloud: IconCloud, github: IconBrandGithub };

export function AccountDialog({
  provider, replace, triggerLabel, primary,
}: { provider: Provider; replace?: { id: string; label: string }; triggerLabel?: string; primary?: boolean }) {
  const info = PROVIDER_INFO[provider];
  const Icon = ICONS[info.icon];
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [label, setLabel] = useState("");
  const mask = useMask();
  const [credential, setCredential] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<TestResult | null>(null);

  function reset(next: boolean) {
    setOpen(next);
    if (!next) {
      setLabel("");
      setCredential("");
      setErrors({});
      setResult(null);
    }
  }

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
        reset(false);
      } else if (!r.fieldErrors && !r.data) {
        toast.error(r.error);
      }
    });
  }

  const kind = info.credentialKind.toLowerCase();
  return (
    <Dialog open={open} onOpenChange={reset}>
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
        <div className="px-[18px] pt-1.5">
          {!replace && (
            <Field id="acc-name" label="Account name" help="Shown next to everything that comes from this account." error={errors.label}>
              <input id="acc-name" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={provider === "vercel" ? "acme" : "utama"} className={fieldClass} />
            </Field>
          )}
          <Field
            id="acc-cred"
            label={info.credentialKind}
            error={errors.credential}
            help={<a href={info.createUrl} target="_blank" rel="noopener noreferrer">Create one <IconExternalLink size={12} className="inline" /></a>}
          >
            {info.json ? (
              <textarea id="acc-cred" spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off" data-gramm="false" value={credential} onChange={(e) => setCredential(e.target.value)} className={`${fieldClass} min-h-24 font-mono text-[12.5px]`} placeholder='{ "type": "service_account", "client_email": "…", "private_key": "…" }' />
            ) : (
              <input id="acc-cred" type="password" spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off" data-gramm="false" value={credential} onChange={(e) => setCredential(e.target.value)} className={fieldClass} placeholder={`Paste the ${kind}`} />
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
          <Button onClick={test} disabled={pending}>Test connection</Button>
          <Button onClick={() => reset(false)} disabled={pending}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={pending}>{pending ? "Working…" : replace ? "Save" : "Connect"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
