"use client";

import { IconBell } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button, Field, fieldClass } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { RULES, type RuleConfig } from "@/lib/alerts/catalog";
import type { RuleTemplates } from "@/lib/alerts/message-template";
import { SEV_OPTIONS } from "@/lib/view/alerts";
import { editRule, testRule } from "./actions";
import { MessageEditor, type Sample, textsFor } from "./message-editor";

const CHANNEL_OPTIONS = [["telegram", "Telegram"], ["discord", "Discord"], ["webhook", "Webhook"], ["smtp", "Email (SMTP)"], ["email_digest", "Daily email digest"]] as const;
const toForm = (r: RuleConfig) => ({
  severity: r.severity as string, threshold: r.threshold === null ? "" : r.threshold.toLocaleString("en-US"), channels: [...r.channels] as string[], enabled: r.enabled,
});
type Form = ReturnType<typeof toForm>;

// Edit and Disable/Enable for one rule (Owners only; the action refuses anyone else). Mockup ruleDlg().
// `templates` and `sample` (1.2.4): the rule's saved message texts and the preview's sample time and next steps.
export function RuleActions({ rule, condition, templates, sample }: { rule: RuleConfig; condition: string; templates: RuleTemplates; sample: Sample }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(() => toForm(rule));
  const [texts, setTexts] = useState(() => textsFor(templates));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const [testing, startTest] = useTransition();
  useHoldRefresh(open);
  const bounds = RULES[rule.key].bounds;

  function show(next: boolean) {
    if (next) {
      setForm(toForm(rule));
      setTexts(textsFor(templates));
      setErrors({});
    }
    setOpen(next);
  }

  // Disable/Enable sends no texts, so the saved ones stay as they are.
  function save(values: Form & { templates?: RuleTemplates }, onSaved: (message: string) => void) {
    start(async () => {
      try {
        const r = await editRule(rule.key, values);
        if (!r.ok) {
          setErrors(r.fieldErrors ?? {});
          toast.error(r.error);
          return;
        }
        onSaved(r.message ?? "");
        setOpen(false);
      } catch {
        toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
      }
    });
  }

  function sendTest() {
    startTest(async () => {
      try {
        const r = await testRule(rule.key, { ...form, templates: texts });
        setErrors(r.ok ? {} : r.fieldErrors ?? {});
        if (r.ok) toast.success("Test sent", { description: r.message });
        else toast.error(r.error);
      } catch {
        toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
      }
    });
  }

  const toggleChannel = (c: string, on: boolean) => setForm({ ...form, channels: on ? [...form.channels, c] : form.channels.filter((x) => x !== c) });

  return (
    <span className="inline-flex gap-1.5">
      {/* Esc and the scrim do nothing while the save runs. */}
      <Dialog open={open} onOpenChange={(next) => { if (!pending) show(next); }}>
        <DialogTrigger render={<Button size="sm">Edit</Button>} />
        <DialogContent className="max-h-[92vh] gap-0 overflow-y-auto p-0 sm:max-w-[620px]" showCloseButton={false}>
          <div className="flex items-start gap-3 px-[18px] pb-2 pt-4">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft"><IconBell size={19} /></span>
            <div>
              <DialogTitle className="text-base">Edit {rule.key}</DialogTitle>
              <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">{condition}</DialogDescription>
            </div>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); save({ ...form, templates: texts }, (message) => toast.success("Rule saved", { description: message })); }}>
            <div className="px-[18px] pt-2">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field id="rule-sev" label="Severity" error={errors.severity}>
                  <select id="rule-sev" className={fieldClass} value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
                    {SEV_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </Field>
                {bounds && (
                  <Field id="rule-num" label="Threshold" help={`Replaces ${rule.threshold?.toLocaleString("en-US") ?? "the number"} in the condition.`} error={errors.threshold}>
                    <input id="rule-num" className={fieldClass} inputMode="numeric" autoComplete="off" value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} />
                  </Field>
                )}
              </div>
              <fieldset className="mb-3.5 flex flex-col gap-[5px]">
                <legend className="mb-[5px] text-[13px] font-medium">Send to</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {CHANNEL_OPTIONS.map(([v, l]) => (
                    <label key={v} className="flex items-center gap-1.5 text-[13px]">
                      <input type="checkbox" className="size-4 accent-brand" checked={form.channels.includes(v)} onChange={(e) => toggleChannel(v, e.target.checked)} />
                      {l}
                    </label>
                  ))}
                </div>
                <span className="text-[12.5px] text-ink-soft">Opens and resolves are sent once; a still-firing alert repeats every 6 hours unless silenced.</span>
                {errors.channels && <span className="text-[12.5px] text-err" role="alert">{errors.channels}</span>}
              </fieldset>
              <label className="mb-3.5 flex items-center gap-1.5 text-[13px]">
                <input type="checkbox" className="size-4 accent-brand" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
                Rule is on
              </label>
              <MessageEditor ruleKey={rule.key} severity={form.severity} threshold={form.threshold} sample={sample} texts={texts} onChange={setTexts} errors={errors} />
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-[18px] py-3">
              {/* 1.2.4 (owner 26 Oct): the message as it is in the box, to the ticked channels, before saving. */}
              <Button className="mr-auto" disabled={pending || testing || !form.channels.some((c) => c !== "email_digest")} onClick={sendTest}
                title="Sends this message, as a made-up alert, to the ticked channels (not the daily digest)">{testing ? "Sending…" : "Send test"}</Button>
              <Button onClick={() => show(false)} disabled={pending}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={pending}>{pending ? "Saving…" : "Save rule"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Button
        size="sm"
        disabled={pending}
        onClick={() => save({ ...toForm(rule), enabled: !rule.enabled }, (message) => (rule.enabled
          ? toast.success(`${rule.key} disabled. It won't fire until you enable it again.`)
          : toast.success(`${rule.key} enabled.`, { description: message })))}
      >
        {rule.enabled ? "Disable" : "Enable"}
      </Button>
    </span>
  );
}
