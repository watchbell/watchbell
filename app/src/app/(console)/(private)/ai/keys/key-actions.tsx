"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button, Field, fieldClass } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { RowMenu } from "@/components/row-menu";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { changeKeyAction, revokeKeyAction } from "@/private/keys/actions";
import { EXPIRY_CHOICES, EXPIRY_LABELS, type ExpiryChoice } from "@/private/keys/scopes";

export type ProviderOption = { id: string; name: string; enabled: boolean };
export type KeyActionsKey = { id: string; name: string; prefix: string; ratePerMin: number; expiresAt: string | null; providerId: string | null; model: string | null };
type Mode = "rename" | "rate" | "expiry" | "routing";

const TEXT: Record<Mode, { title: (name: string) => string; sub: string; cta: string }> = {
  rename: { title: (n) => `Rename ${n}`, sub: "Agents and Logs show the name. Lowercase letters, digits and dashes.", cta: "Save name" },
  rate: { title: () => "Change rate limit", sub: "Requests per minute, 1–600. Applies before the provider's own limits, within a minute.", cta: "Save limit" },
  expiry: { title: () => "Change expiry", sub: "Counted from today. The key stops working at that date.", cta: "Save expiry" },
  routing: { title: () => "Change routing", sub: "Pin this key to one provider and, if you like, one model. Without a pin it uses the default provider.", cta: "Save routing" },
};

function EditForm({ mode, k, providers, onDone }: { mode: Mode; k: KeyActionsKey; providers: ProviderOption[]; onDone: () => void }) {
  const [name, setName] = useState(k.name);
  const [rate, setRate] = useState(String(k.ratePerMin));
  const [expiry, setExpiry] = useState<ExpiryChoice>(k.expiresAt ? "90d" : "never");
  const [providerId, setProviderId] = useState(k.providerId ?? "");
  const [model, setModel] = useState(k.model ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [pending, start] = useTransition();

  function change() {
    if (mode === "rename") return { kind: "rename", name: name.trim() };
    if (mode === "rate") return { kind: "rate", ratePerMin: rate.trim() };
    if (mode === "expiry") return { kind: "expiry", expiry };
    return { kind: "routing", providerId: providerId || null, model: providerId ? model.trim() : null };
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      setErrors({});
      setFormError("");
      try {
        const r = await changeKeyAction(k.id, change());
        if (r.ok) {
          toast.success(r.message ?? "Key updated.");
          onDone();
        } else if (r.fieldErrors) setErrors(r.fieldErrors);
        else setFormError(r.error);
      } catch {
        setFormError("Something went wrong. Try again.");
      }
    });
  }

  const t = TEXT[mode];
  return (
    <form onSubmit={submit} noValidate>
      <div className="px-[18px] pb-2 pt-4">
        <DialogTitle className="text-base">{t.title(k.name)}</DialogTitle>
        <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">{t.sub}</DialogDescription>
      </div>
      <div className="px-[18px] pt-1.5">
        {mode === "rename" && (
          <Field id="edit-name" label="Name" error={errors.name}>
            <input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} className={fieldClass} />
          </Field>
        )}
        {mode === "rate" && (
          <Field id="edit-rate" label="Rate limit" help="Requests per minute." error={errors.ratePerMin}>
            <input id="edit-rate" inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value)} className={`${fieldClass} font-mono`} />
          </Field>
        )}
        {mode === "expiry" && (
          <Field id="edit-expiry" label="Expires" error={errors.expiry}>
            <select id="edit-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value as ExpiryChoice)} className={fieldClass}>
              {EXPIRY_CHOICES.map((c) => <option key={c} value={c}>{EXPIRY_LABELS[c]}</option>)}
            </select>
          </Field>
        )}
        {mode === "routing" && (
          <>
            <Field id="edit-provider" label="Provider" help={providers.length ? undefined : "No provider is connected yet. Until one is, this key has nothing to pin to."} error={errors.providerId}>
              <select id="edit-provider" value={providerId} onChange={(e) => setProviderId(e.target.value)} className={fieldClass}>
                <option value="">No pin (default provider)</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name}{p.enabled ? "" : " (off)"}</option>)}
              </select>
            </Field>
            <Field id="edit-model" label="Model" help="Optional. A Gemini model id, for example gemini-3.8-flash. Empty uses the provider's default." error={errors.model}>
              <input id="edit-model" value={model} onChange={(e) => setModel(e.target.value)} disabled={!providerId} placeholder="gemini-3.8-flash" autoComplete="off" autoCapitalize="none" spellCheck={false} className={`${fieldClass} font-mono`} />
            </Field>
          </>
        )}
        {formError && <p className="mb-3 text-[13px] text-err" role="alert">{formError}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-[18px] py-3">
        <Button onClick={onDone} disabled={pending}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Saving…" : t.cta}</Button>
      </div>
    </form>
  );
}

// The row's Revoke button and kebab (Rename / Change rate limit / Change expiry / Change routing). The form mounts only
// while its dialog is open, so it starts from the key's current values every time.
export function KeyActions({ k, providers }: { k: KeyActionsKey; providers: ProviderOption[] }) {
  const [mode, setMode] = useState<Mode | null>(null);
  useHoldRefresh(mode !== null);
  return (
    <span className="inline-flex items-center gap-1">
      <ConfirmDialog
        trigger={<Button size="sm">Revoke</Button>}
        title={`Revoke ${k.name}?`}
        body={`Calls with ${k.prefix}… answer 401 within a minute. Agents using it show "Key revoked". This can't be undone; create a new key instead.`}
        cta="Revoke key"
        danger
        onConfirm={async () => {
          const r = await revokeKeyAction(k.id);
          return { ok: r.ok, message: (r.ok ? r.message : r.error) ?? "" };
        }}
      />
      <RowMenu
        label={`Actions for ${k.name}`}
        items={[
          { label: "Rename", onSelect: () => setMode("rename") },
          { label: "Change rate limit", onSelect: () => setMode("rate") },
          { label: "Change expiry", onSelect: () => setMode("expiry") },
          { label: "Change routing", onSelect: () => setMode("routing") },
        ]}
      />
      <Dialog open={mode !== null} onOpenChange={(next) => { if (!next) setMode(null); }}>
        <DialogContent className="gap-0 p-0 sm:max-w-[520px]" showCloseButton={false}>
          {mode && <EditForm mode={mode} k={k} providers={providers} onDone={() => setMode(null)} />}
        </DialogContent>
      </Dialog>
    </span>
  );
}
