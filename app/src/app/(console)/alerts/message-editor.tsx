"use client";

import { useRef, useState } from "react";
import { fieldClass } from "@/components/kit";
import { DEFAULT_TEMPLATE, FIELD_HELP, renderTemplate, SAMPLE_DETAIL, storedTemplate, TEMPLATE_FIELDS, TEMPLATE_LANGS, TEMPLATE_MAX, type TemplateValues } from "@/lib/alerts/message-template";
import type { NotifyLang } from "@/lib/notify/lang";

export type Texts = Record<NotifyLang, string>;
export type Sample = { since: string; step: Record<NotifyLang, string | null> };

const LANG_NAME: Record<NotifyLang, string> = { id: "Bahasa Indonesia", en: "English" };
// The words compose.ts uses for a new alert, so the preview reads like the real message.
const OPEN: Record<NotifyLang, string> = { en: "FIRING", id: "MUNCUL" };
const SEV: Record<NotifyLang, Record<string, string>> = { en: { critical: "critical", warning: "warning", info: "info" }, id: { critical: "kritis", warning: "peringatan", info: "info" } };
const HEAD: Record<NotifyLang, string> = { en: "1 firing", id: "1 aktif" };
const LINK: Record<NotifyLang, string> = { en: "Open alerts", id: "Buka Alerts" };

export const textsFor = (saved: Partial<Record<NotifyLang, string>>): Texts => ({ id: saved.id ?? DEFAULT_TEMPLATE.id, en: saved.en ?? DEFAULT_TEMPLATE.en });

// 1.2.4: the rule's notification text per language, a button per field, and a preview filled with sample values.
// Each channel uses the text of the language it is set to (Notifications tab); the webhook uses English.
export function MessageEditor({ ruleKey, severity, threshold, sample, texts, onChange, errors }: {
  ruleKey: string; severity: string; threshold: string; sample: Sample; texts: Texts; onChange: (t: Texts) => void; errors: Record<string, string>;
}) {
  const [lang, setLang] = useState<NotifyLang>("id");
  const box = useRef<HTMLTextAreaElement>(null);
  const text = texts[lang];
  const changed = storedTemplate(text, lang) !== null;
  const values: TemplateValues = {
    status: OPEN[lang], severity: SEV[lang][severity] ?? severity, rule: ruleKey, target: "my-app", detail: SAMPLE_DETAIL[lang], cause: "",
    step: sample.step[lang] ?? "", since: sample.since, threshold,
  };
  const [first = "", ...rest] = renderTemplate(text, values).split("\n");

  function insert(field: string) {
    const el = box.current;
    const at = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? at;
    const token = `{${field}}`;
    onChange({ ...texts, [lang]: text.slice(0, at) + token + text.slice(end) });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + token.length, at + token.length); });
  }

  return (
    <fieldset className="mb-3.5 flex flex-col gap-[5px] border-t border-line pt-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <legend className="text-[13px] font-medium">Message</legend>
        <span className={`rounded-full border px-2 py-px text-[11.5px] ${changed ? "border-brand/40 text-brand" : "border-line text-ink-soft"}`}>{changed ? "Changed" : "Watchbell's wording"}</span>
      </div>
      <span className="text-[12.5px] text-ink-soft">Word the notification yourself. Left as it is, the rule keeps Watchbell&apos;s wording, including later fixes to it.</span>
      <div role="tablist" className="mt-1 flex gap-1 border-b border-line">
        {TEMPLATE_LANGS.map((l) => (
          <button key={l} type="button" role="tab" aria-selected={l === lang} onClick={() => setLang(l)}
            className={`-mb-px border-b-2 px-2.5 py-1.5 text-[13px] ${l === lang ? "border-brand font-medium text-ink" : "border-transparent text-ink-soft hover:text-ink"}`}>
            {LANG_NAME[l]}{storedTemplate(texts[l], l) !== null ? " · changed" : ""}
          </button>
        ))}
      </div>
      <textarea ref={box} id={`rule-msg-${lang}`} aria-label={`Message in ${LANG_NAME[lang]}`} className={`${fieldClass} min-h-[124px] resize-y font-mono text-[12.5px] leading-relaxed`}
        maxLength={TEMPLATE_MAX + 200} value={text} onChange={(e) => onChange({ ...texts, [lang]: e.target.value })} />
      <div className="flex flex-wrap gap-1.5">
        {TEMPLATE_FIELDS.map((f) => (
          <button key={f} type="button" title={FIELD_HELP[f]} onClick={() => insert(f)}
            className="rounded border border-line-strong bg-sunken px-1.5 py-px font-mono text-[12px] text-ink hover:border-brand">{`{${f}}`}</button>
        ))}
      </div>
      {errors[`template_${lang}`] && <span className="text-[12.5px] text-err" role="alert">{errors[`template_${lang}`]}</span>}
      {TEMPLATE_LANGS.filter((l) => l !== lang && errors[`template_${l}`]).map((l) => (
        <span key={l} className="text-[12.5px] text-err" role="alert">{LANG_NAME[l]}: {errors[`template_${l}`]}</span>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px] text-ink-soft">A line whose fields are all empty is left out.</span>
        <button type="button" className="text-[12.5px] text-link underline disabled:opacity-50 disabled:no-underline" disabled={!changed}
          onClick={() => onChange({ ...texts, [lang]: DEFAULT_TEMPLATE[lang] })}>Back to Watchbell&apos;s wording</button>
      </div>
      <div className="mt-1 rounded-md border border-line bg-sunken px-3 py-2.5 text-[13px] leading-relaxed">
        <div className="mb-1 text-[11.5px] uppercase tracking-wide text-ink-faint">Preview, with sample values</div>
        <div className="whitespace-pre-wrap break-words">
          <b>Watchbell</b>: {HEAD[lang]} · {sample.since}{"\n\n"}<b>{first}</b>{rest.length ? `\n${rest.join("\n")}` : ""}{"\n"}<span className="text-link">{LINK[lang]}</span>
        </div>
      </div>
    </fieldset>
  );
}
