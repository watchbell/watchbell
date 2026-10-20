"use client";

import { IconExternalLink } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button, buttonClass, Field, fieldClass } from "@/components/kit";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { connectProvider, replaceProviderKey } from "@/private/ai/providers/actions";
import { PROVIDERS_COPY } from "@/lib/copy/edition";
import { type PresetKind, PRESETS } from "@/private/ai/providers/presets";
import { PROVIDER_ICONS } from "./provider-icons";

const PLACEHOLDER: Record<PresetKind, string> = { gemini: "AQ.… or AIza…", cloudflare: "Paste the API token", custom: "Paste the API key" };

// Mockup EXTRA_DLG.prov: Connect or Replace one provider. Watchbell lists the models and makes one tiny generation call
// before saving (owner finding 07:58: a Google project can list models and still be denied generation).
export function ProviderDialog({
  kind, replace, primary, label, selfhost = false,
}: { kind: PresetKind; replace?: { id: string; name: string; baseUrl: string }; primary?: boolean; label?: string; selfhost?: boolean }) {
  const p = PRESETS[kind];
  const Icon = PROVIDER_ICONS[kind];
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState(replace?.baseUrl ?? "");
  const [makeDefault, setMakeDefault] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);

  // After a successful connect/replace of a custom server, the detected model ids stay on screen until Done.
  const [found, setFound] = useState<string[] | null>(null);
  function reset(next: boolean) {
    setOpen(next);
    if (!next) {
      setFound(null);
      setApiKey(""); setAccountId(""); setName(""); setBaseUrl(replace?.baseUrl ?? ""); setMakeDefault(false); setErrors({}); setProblem(null);
    }
  }

  function save() {
    start(async () => {
      const form = { apiKey, ...(kind === "cloudflare" ? { accountId } : {}), ...(kind === "custom" ? { baseUrl, ...(replace ? {} : { name }) } : {}), makeDefault };
      const r = replace ? await replaceProviderKey(replace.id, form) : await connectProvider(kind, form);
      setErrors(r.ok ? {} : r.fieldErrors ?? {});
      setProblem(r.ok || r.fieldErrors ? null : r.error);
      if (r.ok) {
        toast.success(r.message ?? `${p.name} connected.`);
        const models = r.data?.models ?? [];
        if (kind === "custom" && models.length) setFound(models);
        else reset(false);
      }
    });
  }

  const title = replace ? `Replace key · ${replace.name}` : `Connect ${p.name}`;
  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger className={buttonClass({ size: "sm", variant: primary ? "primary" : "secondary" })}>{label ?? (replace ? "Replace" : "Connect")}</DialogTrigger>
      <DialogContent className="max-w-[560px] gap-0 p-0 sm:max-w-[560px]">
        <div className="flex items-start gap-3 px-[18px] pb-2 pt-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft"><Icon size={19} /></span>
          <div>
            <DialogTitle className="text-base">{title}</DialogTitle>
            <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">{p.keyLabel}{kind === "cloudflare" ? " and account ID" : ""}</DialogDescription>
          </div>
        </div>
        <div className="px-[18px] pt-1.5">
          <p className="mb-3 text-[13px] text-ink-soft">
            {p.where.url && <>Open <a href={p.where.url} target="_blank" rel="noopener noreferrer">{p.where.url.replace("https://", "")} <IconExternalLink size={12} className="inline" aria-hidden /></a>. </>}
            {p.where.text} Watchbell lists the models and makes one tiny generation call before saving.
          </p>
          {kind === "custom" && !replace && (
            <Field id="p-name" label="Name" help="Used in model ids: name/model." error={errors.name}>
              <input id="p-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-llm" className={fieldClass} autoComplete="off" />
            </Field>
          )}
          {kind === "custom" ? (
            <Field id="p-base" label="Base URL" help={selfhost ? PROVIDERS_COPY.baseUrlHelp.selfhost : PROVIDERS_COPY.baseUrlHelp.cloud} error={errors.baseUrl}>
              <input id="p-base" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://example.com/v1" className={`${fieldClass} font-mono text-[12.5px]`} autoComplete="off" />
            </Field>
          ) : (
            <div className="mb-3.5 flex flex-col gap-[5px]">
              <span className="text-[13px] font-medium">Base URL</span>
              <span className="break-all font-mono text-[12.5px] text-ink-faint">{kind === "cloudflare" ? p.baseUrl({ apiKey: "", accountId: "{account_id}" }) : p.baseUrl({ apiKey: "" })}</span>
            </div>
          )}
          {kind === "cloudflare" && (
            <Field id="p-acct" label="Account ID" error={errors.accountId}>
              <input id="p-acct" value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="32 hex characters" className={`${fieldClass} font-mono`} autoComplete="off" spellCheck={false} />
            </Field>
          )}
          <Field id="p-key" label={p.keyLabel} help={kind === "custom" && selfhost ? PROVIDERS_COPY.keyHelp.selfhostCustom : PROVIDERS_COPY.keyHelp.cloud} error={errors.apiKey}>
            <input id="p-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={PLACEHOLDER[kind]} className={`${fieldClass} font-mono`} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-gramm="false" />
          </Field>
          {!replace && (
            <label className="mb-3.5 flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} /> Make this the default provider
            </label>
          )}
          {problem && <div className="mb-3.5 rounded-lg bg-err-soft px-3 py-2.5 text-[13px]" role="alert">{problem}</div>}
          {found && (
            <div className="mb-3.5" role="status">
              <p className="m-0 mb-1.5 text-[13px] font-medium">Found {found.length} model{found.length === 1 ? "" : "s"}:</p>
              <ul className="m-0 flex max-h-40 list-none flex-wrap gap-1.5 overflow-y-auto p-0">
                {found.map((id) => <li key={id} className="rounded border border-line bg-surface-2 px-1.5 font-mono text-[12px]">{id}</li>)}
              </ul>
              <p className="m-0 mt-1.5 text-[12.5px] text-ink-faint">Use Scan all under Models to see which of them really answer.</p>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-[18px] py-3">
          {found ? <Button variant="primary" onClick={() => reset(false)}>Done</Button> : (
            <>
              <Button onClick={() => reset(false)} disabled={pending}>Cancel</Button>
              <Button variant="primary" onClick={save} disabled={pending}>{pending ? "Testing…" : replace ? "Test and replace" : "Test and connect"}</Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
