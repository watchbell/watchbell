"use client";

import { IconHeartbeat } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button, Field, fieldClass } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { AppOption } from "@/lib/data/monitors-db";
import { durationLabel, GRACES_S, PERIODS_S } from "@/lib/heartbeat";
import { type HeartbeatForm, type MonitorForm, parseHeartbeatForm, parseMonitorForm, TIMEOUTS_S } from "@/lib/monitors";
import { addHeartbeat, addMonitor, editHeartbeat, editMonitor } from "../monitor-actions";
import { PingUrlDialog } from "./ping-url-dialog";

type Kind = "http" | "heartbeat";

export type EditableMonitor = {
  id: string; appName: string; url: string; expectedStatus: number; timeoutMs: number;
  bodyContains: string | null; jsonPath: string | null; jsonEquals: string | null;
  kind: Kind; name: string | null; periodS: number | null; graceS: number | null;
};

type Props =
  | { mode: "add"; apps: AppOption[] }
  | { mode: "edit"; monitor: EditableMonitor; open: boolean; onOpenChange: (open: boolean) => void };

type FormState = MonitorForm & HeartbeatForm & { appId: string; kind: Kind };

// The mockup's heartbeat defaults: expected every day, 1 h of grace.
const HB_DEFAULTS = { name: "", periodS: "86400", graceS: "3600" };
const KINDS: [Kind, string, string][] = [
  ["http", "HTTP check", "The collector opens a URL every minute"],
  ["heartbeat", "Heartbeat", "Your cron job or backup script pings a secret URL when it runs"],
];

function initial(props: Props): FormState {
  if (props.mode === "edit") {
    const m = props.monitor;
    return {
      appId: "", kind: m.kind, url: m.kind === "http" ? m.url : "", expectedStatus: String(m.expectedStatus), timeoutS: String(Math.round(m.timeoutMs / 1000)),
      bodyContains: m.bodyContains ?? "", jsonPath: m.jsonPath ?? "", jsonEquals: m.jsonEquals ?? "",
      name: m.name ?? "", periodS: String(m.periodS ?? HB_DEFAULTS.periodS), graceS: String(m.graceS ?? HB_DEFAULTS.graceS),
    };
  }
  const first = props.apps[0];
  // The mockup's default: the first app's domain with /api/health.
  return {
    appId: first?.id ?? "", kind: "http", url: first ? `https://${first.domain}/api/health` : "", expectedStatus: "200", timeoutS: "5",
    bodyContains: "", jsonPath: "", jsonEquals: "", ...HB_DEFAULTS,
  };
}

// Edit mode is mounted by its parent only while open, so the form starts from the monitor's current values. A
// monitor's type is chosen when it is added; Edit shows the fields of the type it has.
export function MonitorDialog(props: Props) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = props.mode === "edit" ? props.open : ownOpen;
  const [form, setForm] = useState<FormState>(() => initial(props));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  // Add heartbeat → the ping URL dialog, once (the token is never shown again).
  const [shown, setShown] = useState<{ name: string; url: string } | null>(null);
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
    const heartbeat = form.kind === "heartbeat";
    const parsed = heartbeat ? parseHeartbeatForm(form) : parseMonitorForm(form);
    if (!parsed.ok) {
      setErrors(parsed.fieldErrors);
      return;
    }
    setErrors({});
    start(async () => {
      const r = heartbeat
        ? props.mode === "add" ? await addHeartbeat(form.appId, form) : await editHeartbeat(props.monitor.id, form)
        : props.mode === "add" ? await addMonitor(form.appId, form) : await editMonitor(props.monitor.id, form);
      if (!r.ok) {
        setErrors(r.fieldErrors ?? {});
        toast.error(r.error);
        return;
      }
      toast.success(props.mode === "add" ? "Monitor added" : "Monitor saved", { description: r.message });
      setOpen(false);
      const url = r.data && "pingUrl" in r.data ? r.data.pingUrl : null;
      if (url) setShown({ name: form.name.trim(), url });
    });
  }

  const apps = props.mode === "add" ? props.apps : [];
  const noApps = props.mode === "add" && apps.length === 0;
  const heartbeat = form.kind === "heartbeat";
  const about = props.mode === "add"
    ? "HTTP checks run every minute from the collector. Heartbeats wait for your job to ping the console."
    : heartbeat ? "Your job pings the console; nothing is fetched." : "Checked every minute from the collector.";

  return (
    <>
      {/* Esc and the scrim do nothing while the save runs. */}
      <Dialog open={open} onOpenChange={(next) => { if (!pending) setOpen(next); }}>
        {props.mode === "add" && (noApps
          ? <span title="Watch an app first, in Connections → Sync" className="inline-flex"><Button variant="primary" disabled>Add monitor</Button></span>
          : <DialogTrigger render={<Button variant="primary">Add monitor</Button>} />)}
        <DialogContent className="gap-0 p-0 sm:max-w-[640px]" showCloseButton={false}>
          <div className="flex items-start gap-3 px-[18px] pb-2 pt-4">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft"><IconHeartbeat size={19} /></span>
            <div>
              <DialogTitle className="text-base">{props.mode === "add" ? "Add monitor" : "Edit monitor"}</DialogTitle>
              <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">{about}</DialogDescription>
            </div>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <div className="px-[18px] pt-2">
              {props.mode === "add" && (
                <fieldset className="mb-3.5">
                  <legend className="mb-[5px] text-[13px] font-medium">Type</legend>
                  <div className="overflow-hidden rounded-lg border border-line">
                    {KINDS.map(([value, label, desc]) => (
                      <label key={value} className="flex cursor-pointer items-start gap-2.5 border-t border-line px-3 py-[9px] first:border-t-0 hover:bg-hover">
                        <input
                          type="radio" name="mon-kind" value={value} checked={form.kind === value} className="mt-[3px] accent-brand"
                          onChange={() => { setForm({ ...form, kind: value }); setErrors({}); }}
                        />
                        <span>{label}<small className="block text-xs text-ink-faint">{desc}</small></span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              <Field id="mon-app" label="Application">
                {props.mode === "add" ? (
                  <select
                    id="mon-app"
                    className={fieldClass}
                    value={form.appId}
                    onChange={(e) => {
                      const a = apps.find((x) => x.id === e.target.value);
                      setForm({ ...form, appId: e.target.value, url: a ? `https://${a.domain}/` : form.url });
                    }}
                  >
                    {apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                ) : (
                  <input id="mon-app" className={fieldClass} value={props.monitor.appName} disabled />
                )}
              </Field>
              {heartbeat ? (
                <>
                  <Field id="hb-name" label="Name" error={errors.name}>
                    <input id="hb-name" className={fieldClass} value={form.name} placeholder="backup job" maxLength={80} autoComplete="off" onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  </Field>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field id="hb-every" label="Expected every" error={errors.periodS}>
                      <select id="hb-every" className={fieldClass} value={form.periodS} onChange={(e) => setForm({ ...form, periodS: e.target.value })}>
                        {PERIODS_S.map((s) => <option key={s} value={String(s)}>{durationLabel(s)}</option>)}
                      </select>
                    </Field>
                    <Field id="hb-grace" label="Grace time" error={errors.graceS}>
                      <select id="hb-grace" className={fieldClass} value={form.graceS} onChange={(e) => setForm({ ...form, graceS: e.target.value })}>
                        {GRACES_S.map((s) => <option key={s} value={String(s)}>{durationLabel(s)}</option>)}
                      </select>
                    </Field>
                  </div>
                  <p className="mb-3 text-[13px] text-ink-soft">
                    Late once the period passes, down after the grace time too.{props.mode === "add" ? " The ping URL is shown once after you add it." : ""}
                  </p>
                </>
              ) : (
                <>
                  <Field id="mon-url" label="URL" help="Must start with https://. A health route that touches nothing heavy works best." error={errors.url}>
                    <input id="mon-url" className={fieldClass} value={form.url} autoComplete="off" spellCheck={false} onChange={(e) => setForm({ ...form, url: e.target.value })} />
                  </Field>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field id="mon-code" label="Expected status" error={errors.expectedStatus}>
                      <input id="mon-code" className={fieldClass} inputMode="numeric" value={form.expectedStatus} onChange={(e) => setForm({ ...form, expectedStatus: e.target.value })} />
                    </Field>
                    <Field id="mon-timeout" label="Timeout" error={errors.timeoutS}>
                      <select id="mon-timeout" className={fieldClass} value={form.timeoutS} onChange={(e) => setForm({ ...form, timeoutS: e.target.value })}>
                        {TIMEOUTS_S.map((s) => <option key={s} value={String(s)}>{s} s</option>)}
                      </select>
                    </Field>
                  </div>
                  <Field id="mon-match" label="Response must contain (optional)" help="Plain text, case-sensitive. The first 256 KB of the response is searched and never stored." error={errors.bodyContains}>
                    <input id="mon-match" className={fieldClass} value={form.bodyContains ?? ""} placeholder='e.g. "status":"ok"' autoComplete="off" spellCheck={false} onChange={(e) => setForm({ ...form, bodyContains: e.target.value })} />
                  </Field>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field id="mon-jpath" label="Or JSON field (optional)" error={errors.jsonPath}>
                      <input id="mon-jpath" className={`${fieldClass} font-mono`} value={form.jsonPath ?? ""} placeholder="status or checks.db" autoComplete="off" spellCheck={false} onChange={(e) => setForm({ ...form, jsonPath: e.target.value })} />
                    </Field>
                    <Field id="mon-jeq" label="Equals" error={errors.jsonEquals}>
                      <input id="mon-jeq" className={`${fieldClass} font-mono`} value={form.jsonEquals ?? ""} placeholder="ok" autoComplete="off" spellCheck={false} onChange={(e) => setForm({ ...form, jsonEquals: e.target.value })} />
                    </Field>
                  </div>
                  <p className="mb-3 text-[13px] text-ink-soft">Marked down after 3 failed checks in a row. A missing keyword counts as a failed check.</p>
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-[18px] py-3">
              <Button onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={pending}>{pending ? "Saving…" : props.mode === "add" ? "Add monitor" : "Save"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <PingUrlDialog name={shown?.name ?? ""} url={shown?.url ?? null} onClose={() => setShown(null)} />
    </>
  );
}
