"use client";

import { type ReactNode, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button, Card, fieldClass } from "@/components/kit";
import { type Brand, logoFileProblem } from "@/lib/branding";
import { cn } from "@/lib/utils";
import { removeBrandLogo, saveBranding } from "./branding-actions";

// Watchbell 1.7 (spec §2.5, §7): one brand per install, owner only. It reaches the sign-in page, the sidebar, the
// browser tab, the accent colour, the monthly report, every email and the public status page. The CLI, docs links and
// the version label stay Watchbell.

const ROW = "grid grid-cols-[260px_minmax(0,1fr)] items-center gap-4 border-b border-line py-3 last:border-b-0 max-[720px]:grid-cols-1 max-[720px]:gap-1";

function FormRow({ id, label, help, error, children }: { id?: string; label: string; help?: string; error?: string; children: ReactNode }) {
  return (
    <div className={ROW}>
      <label htmlFor={id} className="font-medium">
        {label}
        {help && <span className="mt-0.5 block text-[12.5px] font-normal text-ink-soft">{help}</span>}
      </label>
      <div className="min-w-0">
        {children}
        {error && <span className="mt-1 block text-[12.5px] text-err" role="alert">{error}</span>}
      </div>
    </div>
  );
}

export function BrandingTab({ brand }: { brand: Brand }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [accent, setAccent] = useState(brand.accent ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();

  function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const file = form.get("logo");
    const problem = file instanceof File ? logoFileProblem(file) : null;
    if (problem) {
      setErrors({ logo: problem });
      toast.error("Check the highlighted fields.");
      return;
    }
    start(async () => {
      try {
        const r = await saveBranding(form);
        if (!r.ok) {
          setErrors(r.fieldErrors ?? {});
          toast.error(r.error);
          return;
        }
        setErrors({});
        toast.success(r.message ?? "Branding saved.");
      } catch {
        toast.error("Branding couldn't be saved. Try a smaller logo, or try again.");
      }
    });
  }

  function removeLogo() {
    start(async () => {
      const r = await removeBrandLogo();
      if (r.ok) toast.success(r.message ?? "Logo removed.");
      else toast.error(r.error);
    });
  }

  const swatch = /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : undefined;
  return (
    <form ref={formRef} onSubmit={save} className="flex flex-col gap-4" encType="multipart/form-data">
      <Card title="Branding">
        <p className="mb-2 text-[12.5px] text-ink-soft">
          Your name and colours on what your clients see: the sign-in page, the sidebar, the monthly report, emails and the
          public status page. The command line, links to the docs and the version label stay Watchbell.
        </p>
        <FormRow id="br-name" label="App name" help="Shown instead of Watchbell. Up to 60 characters." error={errors.name}>
          <input id="br-name" name="name" className={cn(fieldClass, "max-w-[320px]")} defaultValue={brand.name ?? ""} maxLength={60} placeholder="e.g. Studio Nusa Monitoring" />
        </FormRow>
        <FormRow id="br-logo" label="Logo" help="A square PNG, at most 512 × 512 px and 256 KB." error={errors.logo}>
          <div className="flex flex-wrap items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- a small stored PNG, served by /brand-icon */}
            {brand.hasLogo && <img src="/brand-icon" alt="Current logo" width={32} height={32} className="size-8 rounded-md border border-line" />}
            <input id="br-logo" name="logo" type="file" accept="image/png" className="text-[12.5px]" />
            {brand.hasLogo && <Button type="button" size="sm" onClick={removeLogo} disabled={pending}>Remove logo</Button>}
          </div>
        </FormRow>
        <FormRow id="br-accent" label="Accent colour" help="Buttons, links and charts. Checked to stay readable on light and dark backgrounds." error={errors.accent}>
          <div className="flex items-center gap-2">
            <span aria-hidden className="size-6 rounded-md border border-line" style={swatch ? { background: swatch } : undefined} />
            <input id="br-accent" name="accent" className={cn(fieldClass, "max-w-[140px] font-mono text-[12.5px]")} value={accent} maxLength={7} placeholder="#1f45c9" onChange={(e) => setAccent(e.target.value)} />
          </div>
        </FormRow>
        <FormRow id="br-sender" label="Email sender name" help="The name your reports and alerts come from. The address stays the one your mail channel uses." error={errors.senderName}>
          <input id="br-sender" name="senderName" className={cn(fieldClass, "max-w-[320px]")} defaultValue={brand.senderName ?? ""} maxLength={60} placeholder="e.g. Studio Nusa" />
        </FormRow>
        <FormRow id="br-url" label="Public address" help="Where this console is reached: the links in alert and digest emails, and the logo in report emails. Blank uses the address Watchbell runs at." error={errors.publicUrl}>
          <input id="br-url" name="publicUrl" className={cn(fieldClass, "max-w-[420px] font-mono text-[12.5px]")} defaultValue={brand.publicUrl ?? ""} placeholder="https://monitor.example.com" spellCheck={false} />
        </FormRow>
        <FormRow id="br-powered" label="Powered by Watchbell" help="A small grey line on the sign-in page, reports, emails and the status page.">
          <label className="inline-flex items-center gap-1.5">
            <input id="br-powered" name="poweredBy" type="checkbox" className="size-4 accent-brand" defaultChecked={brand.poweredBy} />
            Show it
          </label>
        </FormRow>
      </Card>
      <div><Button type="submit" variant="primary" disabled={pending}>{pending ? "Saving…" : "Save branding"}</Button></div>
    </form>
  );
}
