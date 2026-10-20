"use client";

import { IconCircleCheck, IconCopy, IconKey, IconPlus } from "@tabler/icons-react";
import { KEYS_COPY } from "@/lib/copy/edition";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button, Field, fieldClass } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { type CreatedKey, createKeyAction } from "@/private/keys/actions";
import { ScopeChips } from "@/private/keys/scope-chips";
import { DEFAULT_EXPIRY, DEFAULT_RATE_PER_MIN, DEFAULT_SCOPES, EXPIRY_CHOICES, EXPIRY_LABELS, type ExpiryChoice, SCOPE_INFO, SCOPES, type Scope } from "@/private/keys/scopes";

// Create key (mockup EXTRA_DLG.aikey) and, once it worked, the key-shown-once dialog (the second step of the same dialog).
// The secret lives only in this component's state: it is never written to storage, and closing the dialog drops it.

function Head({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div className="flex items-start gap-3 px-[18px] pb-2 pt-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft">{icon}</span>
      <div>
        <DialogTitle className="text-base">{title}</DialogTitle>
        <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">{sub}</DialogDescription>
      </div>
    </div>
  );
}

function CreateKeyForm({ onCreated, onCancel }: { onCreated: (k: CreatedKey) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(DEFAULT_SCOPES);
  const [expiry, setExpiry] = useState<ExpiryChoice>(DEFAULT_EXPIRY);
  const [rate, setRate] = useState(String(DEFAULT_RATE_PER_MIN));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [pending, start] = useTransition();

  const toggle = (s: Scope) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      setErrors({});
      setFormError("");
      try {
        const r = await createKeyAction({ name: name.trim(), scopes: SCOPES.filter((s) => scopes.includes(s)), expiry, ratePerMin: rate.trim() });
        if (r.ok && r.data) {
          toast.success(r.message ?? "Key created.");
          onCreated(r.data);
        } else if (!r.ok) {
          if (r.fieldErrors) setErrors(r.fieldErrors);
          else setFormError(r.error);
        }
      } catch {
        setFormError("Something went wrong. Try again.");
      }
    });
  }

  return (
    <form onSubmit={submit} noValidate>
      <Head icon={<IconKey size={19} />} title="Create API key" sub="For one app or agent. Shown once." />
      <div className="px-[18px] pt-1.5">
        <Field id="key-name" label="Name" help="Lowercase letters, digits and dashes. Agents and Logs show it." error={errors.name}>
          <input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={KEYS_COPY.namePlaceholder} autoComplete="off" autoCapitalize="none" spellCheck={false} className={fieldClass} />
        </Field>
        <fieldset className="mb-3.5">
          <legend className="mb-[5px] text-[13px] font-medium">Scopes</legend>
          <div className="flex flex-col gap-1.5">
            {SCOPES.map((s) => (
              <label key={s} className="flex cursor-pointer items-start gap-2">
                <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} className="mt-[3px] accent-brand" />
                <span><ScopeChips scopes={[s]} /> <span className="text-[13px] text-ink-soft">{SCOPE_INFO[s].short}</span></span>
              </label>
            ))}
          </div>
          {errors.scopes && <span className="text-[12.5px] text-err" role="alert">{errors.scopes}</span>}
        </fieldset>
        <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
          <Field id="key-expiry" label="Expires" error={errors.expiry}>
            <select id="key-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value as ExpiryChoice)} className={fieldClass}>
              {EXPIRY_CHOICES.map((c) => <option key={c} value={c}>{EXPIRY_LABELS[c]}</option>)}
            </select>
          </Field>
          <Field id="key-rate" label="Rate limit" help="Requests per minute, 1–600. Applies before the provider's own limits." error={errors.ratePerMin}>
            <input id="key-rate" inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value)} className={`${fieldClass} font-mono`} />
          </Field>
        </div>
        {formError && <p className="mb-3 text-[13px] text-err" role="alert">{formError}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-[18px] py-3">
        <Button onClick={onCancel} disabled={pending}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Creating…" : "Create key"}</Button>
      </div>
    </form>
  );
}

function KeyShown({ created, onDone }: { created: CreatedKey; onDone: () => void }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(created.key);
      toast.success("Copied.");
    } catch {
      toast.error("Couldn't copy. Select the key and copy it by hand.");
    }
  }
  return (
    <div>
      <Head icon={<IconCircleCheck size={19} />} title={`Key ${created.name} created`} sub="Copy it now." />
      <div className="px-[18px] pb-3 pt-1.5">
        <div className="flex items-center gap-1.5">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-line bg-sunken px-2 py-1.5 font-mono text-[12.5px]" data-testid="new-key">{created.key}</code>
          <Button size="sm" onClick={copy}><IconCopy size={15} aria-hidden />Copy</Button>
        </div>
        <p className="mt-2.5 rounded-md border border-warn-icon bg-warn-soft px-2.5 py-2 text-[13px] text-warn">
          Watchbell keeps only a SHA-256 hash of this key, so it can&apos;t show it again. Lost it? Revoke it and create a new one.
        </p>
        <p className="mb-0 mt-3 text-[13px] text-ink-soft">
          Next: put it in the app&apos;s environment as <span className="font-mono">WATCHBELL_API_KEY</span>, then follow <Link href="/ai" className="text-brand">Quick start</Link> or <Link href="/ai/connect" className="text-brand">Connect an agent</Link>.
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-[18px] py-3">
        <Button variant="primary" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

export function CreateKeyDialog() {
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  useHoldRefresh(open);

  function change(next: boolean) {
    setOpen(next);
    if (!next) setCreated(null); // the secret goes with the dialog
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger render={<Button variant="primary" />}><IconPlus size={16} aria-hidden />Create key</DialogTrigger>
      <DialogContent className="gap-0 p-0 sm:max-w-[640px]" showCloseButton={false}>
        {created ? <KeyShown created={created} onDone={() => change(false)} /> : <CreateKeyForm onCreated={setCreated} onCancel={() => change(false)} />}
      </DialogContent>
    </Dialog>
  );
}
