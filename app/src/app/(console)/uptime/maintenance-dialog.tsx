"use client";

import { IconTool } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button, Field, fieldClass } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { durationText, DURATIONS_MIN, ENDED, hasEnded, NOTE_MAX, parseWindowForm, splitTarget, targetValue, type Window } from "@/lib/maintenance";
import { toLocalInput, zoneSentence } from "@/lib/time";
import { addWindow, editWindow } from "../maintenance-actions";

export type TargetOptions = { apps: { id: string; name: string }[]; monitors: { id: string; label: string }[] };
export type EditableWindow = Window & { target: string };

type Props =
  | { mode: "add"; options: TargetOptions }
  | { mode: "edit"; options: TargetOptions; win: EditableWindow; open: boolean; onOpenChange: (open: boolean) => void };

type FormState = { target: string; weekly: boolean; start: string; durationMin: string; note: string };

const HOUR = 3_600_000;

function initial(props: Props): FormState {
  if (props.mode === "edit") {
    const w = props.win;
    return { target: targetValue(w), weekly: w.weekly, start: toLocalInput(w.startsAt), durationMin: String(w.durationMin), note: w.note ?? "" };
  }
  // The next whole hour, in WIB, for an hour and a half (the mockup's default length).
  return { target: "all", weekly: false, start: toLocalInput(new Date(Math.ceil(Date.now() / HOUR) * HOUR)), durationMin: "90", note: "" };
}

const toForm = (f: FormState) => ({ ...splitTarget(f.target), start: f.start, durationMin: f.durationMin, weekly: f.weekly, note: f.note });

// Mockup maintDlg(). Edit mode is mounted by its parent only while open, so the form starts from the window's values.
export function MaintenanceDialog(props: Props) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = props.mode === "edit" ? props.open : ownOpen;
  const [form, setForm] = useState<FormState>(() => initial(props));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  useHoldRefresh(open);

  function setOpen(next: boolean) {
    if (next) {
      setForm(initial(props));
      setErrors({});
    }
    if (props.mode === "edit") props.onOpenChange(next);
    else setOwnOpen(next);
  }

  function submit() {
    const values = toForm(form);
    const parsed = parseWindowForm(values);
    if (!parsed.ok) {
      setErrors(parsed.fieldErrors);
      return;
    }
    if (hasEnded(parsed.value, new Date())) {
      setErrors({ start: ENDED });
      return;
    }
    setErrors({});
    start(async () => {
      const r = props.mode === "add" ? await addWindow(values) : await editWindow(props.win.id, values);
      if (!r.ok) {
        setErrors(r.fieldErrors ?? {});
        toast.error(r.error);
        return;
      }
      toast.success("Window saved", { description: r.message });
      setOpen(false);
    });
  }

  const { apps, monitors } = props.options;
  // A window on an app or monitor that is no longer in the lists (its app was unwatched) keeps its own option.
  const current = props.mode === "edit" ? targetValue(props.win) : null;
  const listed = current === "all" || apps.some((a) => `app:${a.id}` === current) || monitors.some((m) => `monitor:${m.id}` === current);
  const targetError = errors.scope ?? errors.targetId;

  return (
    // Esc and the scrim do nothing while the save runs.
    <Dialog open={open} onOpenChange={(next) => { if (!pending) setOpen(next); }}>
      {props.mode === "add" && <DialogTrigger render={<Button>Add maintenance window</Button>} />}
      <DialogContent className="gap-0 p-0 sm:max-w-[560px]" showCloseButton={false}>
        <div className="flex items-start gap-3 px-[18px] pb-2 pt-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft"><IconTool size={19} /></span>
          <div>
            <DialogTitle className="text-base">{props.mode === "add" ? "Add maintenance window" : "Edit maintenance window"}</DialogTitle>
            <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">Checks keep running, but they are left out of uptime % and open no alerts. {zoneSentence()}</DialogDescription>
          </div>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="px-[18px] pt-2">
            <Field id="mw-scope" label="Applies to" error={targetError}>
              <select id="mw-scope" className={fieldClass} value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })}>
                <option value="all">All monitors</option>
                {props.mode === "edit" && !listed && current && <option value={current}>{props.win.target}</option>}
                {apps.length > 0 && (
                  <optgroup label="Application">
                    {apps.map((a) => <option key={a.id} value={`app:${a.id}`}>{a.name}</option>)}
                  </optgroup>
                )}
                {monitors.length > 0 && (
                  <optgroup label="One monitor">
                    {monitors.map((m) => <option key={m.id} value={`monitor:${m.id}`}>{m.label}</option>)}
                  </optgroup>
                )}
              </select>
            </Field>
            <fieldset className="mb-3.5 flex flex-col gap-[5px]">
              <legend className="mb-[5px] text-[13px] font-medium">Repeat</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {([[false, "Once"], [true, "Every week"]] as const).map(([weekly, label]) => (
                  <label key={label} className="flex items-center gap-1.5 text-[13px]">
                    <input type="radio" name="mw-rep" className="size-4 accent-brand" checked={form.weekly === weekly} onChange={() => setForm({ ...form, weekly })} />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id="mw-start" label="Starts" error={errors.start}>
                <input id="mw-start" type="datetime-local" className={fieldClass} value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
              </Field>
              <Field id="mw-len" label="Lasts" error={errors.durationMin}>
                <select id="mw-len" className={fieldClass} value={form.durationMin} onChange={(e) => setForm({ ...form, durationMin: e.target.value })}>
                  {DURATIONS_MIN.map((m) => <option key={m} value={String(m)}>{durationText(m)}</option>)}
                </select>
              </Field>
            </div>
            <Field id="mw-note" label="Note (optional)" help="Shown on the public status page if a monitor there is affected.">
              <input id="mw-note" className={fieldClass} value={form.note} maxLength={NOTE_MAX} placeholder="Moving DNS to Cloudflare" autoComplete="off" onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-[18px] py-3">
            <Button onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={pending}>{pending ? "Saving…" : props.mode === "add" ? "Add window" : "Save"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
