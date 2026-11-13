"use client";

import { IconFileText } from "@tabler/icons-react";
import { type ReactNode, useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button, buttonClass, Card, EmptyState, fieldClass, Tag } from "@/components/kit";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ReportRow } from "@/lib/data/report-db";
import { cn } from "@/lib/utils";
import { deleteReportAction, saveReportContent, saveReportDelivery, sendTestReport } from "./actions";

// Watchbell 1.7 (spec §2.1–2.3): one card per client report. Viewers download; operators edit what it says, send a
// test to themselves and add reports; owners also decide who gets it, automatic sending and the sender. The list never
// shows an address.

type Role = "owner" | "operator" | "viewer";
type Month = { value: string; label: string };
type Props = { reports: ReportRow[]; months: Month[]; monitors: { id: string; label: string }[]; senders: { smtp: boolean; resend: boolean }; role: Role };

const LANG = { id: "Indonesian", en: "English" } as const;
const monthLabel = (m: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-15T12:00:00Z`));

function sendLine(r: ReportRow): string {
  if (!r.autoSend) return "Automatic sending is off";
  const n = r.recipients.length;
  return `Emailed on the 1st to ${n} address${n === 1 ? "" : "es"}`;
}

function lastSendText(r: ReportRow): string | null {
  if (!r.lastSend) return null;
  const m = monthLabel(r.lastSend.month);
  if (r.lastSend.status === "sent") return `${m} sent`;
  if (r.lastSend.status === "failed") return `${m} not sent: ${r.lastSend.lastError ?? "unknown reason"}`;
  return `${m} waiting for a retry${r.lastSend.lastError ? ` (${r.lastSend.lastError})` : ""}`;
}

export function ReportsView({ reports, months, monitors, senders, role }: Props) {
  const canEdit = role !== "viewer";
  const [editing, setEditing] = useState<ReportRow | "new" | null>(null);
  const [delivery, setDelivery] = useState<ReportRow | null>(null);
  return (
    <div className="flex flex-col gap-4">
      {canEdit && (
        <div><Button variant="primary" onClick={() => setEditing("new")}>New report</Button></div>
      )}
      {!reports.length && (
        <Card>
          <EmptyState icon={IconFileText} title="No reports yet">
            A report is a two-page PDF for one client: the month&apos;s uptime as a calendar, incidents in plain words, response
            times and updates. Download it any time, or have it emailed on the 1st of each month.
          </EmptyState>
        </Card>
      )}
      {reports.map((r) => (
        <ReportCard key={r.id} r={r} months={months} role={role} onEdit={() => setEditing(r)} onDelivery={() => setDelivery(r)} />
      ))}
      {editing && <ContentDialog report={editing === "new" ? null : editing} monitors={monitors} onClose={() => setEditing(null)} />}
      {delivery && <DeliveryDialog report={delivery} senders={senders} onClose={() => setDelivery(null)} />}
    </div>
  );
}

function ReportCard({ r, months, role, onEdit, onDelivery }: { r: ReportRow; months: Month[]; role: Role; onEdit: () => void; onDelivery: () => void }) {
  const finished = months.filter((m) => !m.label.endsWith("(so far)"));
  const [month, setMonth] = useState(finished[0]?.value ?? months[0]?.value ?? "");
  const [lang, setLang] = useState<"id" | "en">(r.lang);
  const [pending, start] = useTransition();
  const [deleting, setDeleting] = useState(false);
  const last = lastSendText(r);

  const test = () => start(async () => {
    const res = await sendTestReport(r.id, month);
    if (res.ok) toast.success(res.message ?? "Test sent.");
    else toast.error(res.error);
  });
  // ConfirmDialog shows the result itself.
  const remove = async () => {
    const res = await deleteReportAction(r.id);
    return res.ok ? { ok: true, message: res.message ?? "Report deleted." } : { ok: false, message: res.error };
  };

  return (
    <Card title={r.clientName} meta={<Tag>{LANG[r.lang]}</Tag>}>
      <div className="flex flex-col gap-3 text-[13px]">
        <div className="text-ink-soft">
          {r.title ? `${r.title} · ` : ""}{r.sites.length ? r.sites.map((s) => s.displayName).join(", ") : "No websites yet"}
        </div>
        <div className="text-ink-soft">
          {sendLine(r)}{last && <> · <span className={cn(r.lastSend?.status === "failed" && "text-err")}>{last}</span></>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Month" className={cn(fieldClass, "w-auto")} value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <select aria-label="Language of this download" className={cn(fieldClass, "w-auto")} value={lang} onChange={(e) => setLang(e.target.value as "id" | "en")}>
            <option value="id">Indonesian</option>
            <option value="en">English</option>
          </select>
          {month && r.sites.length > 0
            ? <a className={buttonClass({ variant: "primary", size: "sm" })} href={`/reports/${r.id}/pdf?month=${month}&lang=${lang}`} download>Download PDF</a>
            : <span className="text-ink-faint">Add a website to download a PDF.</span>}
          {role !== "viewer" && <Button size="sm" onClick={test} disabled={pending || !r.sites.length}>Send test</Button>}
          {role !== "viewer" && <Button size="sm" onClick={onEdit}>Edit</Button>}
          {role === "owner" && <Button size="sm" onClick={onDelivery}>Delivery</Button>}
          {role === "owner" && <Button size="sm" variant="ghost" onClick={() => setDeleting(true)} disabled={pending}>Delete</Button>}
        </div>
      </div>
      {role === "owner" && (
        <ConfirmDialog open={deleting} onOpenChange={setDeleting} title={`Delete the report for ${r.clientName}?`}
          body="The report and its send history go. The monitoring data stays." cta="Delete" danger onConfirm={remove} />
      )}
    </Card>
  );
}

function Row({ label, help, error, children }: { label: string; help?: string; error?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[13px]">
      <span className="font-medium">{label}{help && <span className="block text-[12px] font-normal text-ink-soft">{help}</span>}</span>
      {children}
      {error && <span className="text-[12.5px] text-err" role="alert">{error}</span>}
    </label>
  );
}

function ContentDialog({ report, monitors, onClose }: { report: ReportRow | null; monitors: { id: string; label: string }[]; onClose: () => void }) {
  const [clientName, setClient] = useState(report?.clientName ?? "");
  const [title, setTitle] = useState(report?.title ?? "");
  const [lang, setLang] = useState<"id" | "en">(report?.lang ?? "id");
  const [note, setNote] = useState(report?.note ?? "");
  const [opening, setOpening] = useState(report?.emailOpening ?? "");
  const [sites, setSites] = useState<Record<string, string>>(Object.fromEntries((report?.sites ?? []).map((s) => [s.monitorId, s.displayName])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const save = () => start(async () => {
    const order = [...(report?.sites.map((s) => s.monitorId) ?? []), ...monitors.map((m) => m.id)];
    const chosen = [...new Set(order)].filter((id) => id in sites).map((monitorId) => ({ monitorId, displayName: sites[monitorId] }));
    const r = await saveReportContent(report?.id ?? null, { clientName, title, lang, note, emailOpening: opening, sites: chosen });
    if (!r.ok) {
      setErrors(r.fieldErrors ?? {});
      toast.error(r.error);
      return;
    }
    toast.success(r.message ?? "Report saved.");
    onClose();
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[560px]">
        <DialogTitle className="text-base">{report ? `Edit ${report.clientName}` : "New report"}</DialogTitle>
        <DialogDescription>What the client reads. Website names are yours to choose; the PDF never shows an address.</DialogDescription>
        <div className="flex flex-col gap-3">
          <Row label="Client" error={errors.clientName}><input className={fieldClass} value={clientName} maxLength={120} onChange={(e) => setClient(e.target.value)} placeholder="e.g. PT Kopi Sejahtera" /></Row>
          <Row label="Title" help="Blank: Website monitoring report / Laporan pemantauan website."><input className={fieldClass} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></Row>
          <Row label="Language" error={errors.lang}>
            <select className={fieldClass} value={lang} onChange={(e) => setLang(e.target.value as "id" | "en")}><option value="id">Indonesian</option><option value="en">English</option></select>
          </Row>
          <div className="flex flex-col gap-1 text-[13px]">
            <span className="font-medium">Websites<span className="block text-[12px] font-normal text-ink-soft">Tick the uptime monitors to include and give each the name the client knows.</span></span>
            {monitors.map((m) => (
              <div key={m.id} className="flex items-center gap-2">
                <input type="checkbox" className="size-4 accent-brand" aria-label={`Include ${m.label}`} checked={m.id in sites}
                  onChange={(e) => setSites((s) => { const n = { ...s }; if (e.target.checked) n[m.id] = n[m.id] ?? ""; else delete n[m.id]; return n; })} />
                <span className="w-[42%] truncate text-ink-soft" title={m.label}>{m.label}</span>
                {m.id in sites && <input className={cn(fieldClass, "flex-1")} value={sites[m.id]} maxLength={80} placeholder="Name in the report" aria-label={`Name for ${m.label}`} onChange={(e) => setSites((s) => ({ ...s, [m.id]: e.target.value }))} />}
              </div>
            ))}
            {!monitors.length && <span className="text-ink-faint">No uptime monitors yet. Add one under Hosting › Uptime.</span>}
            {errors.sites && <span className="text-[12.5px] text-err" role="alert">{errors.sites}</span>}
          </div>
          <Row label="Note for the client" help="Optional. Printed on page 2 of every report until you change it."><textarea className={fieldClass} rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></Row>
          <Row label="Email opening" help="Optional. Blank: a short greeting in the report's language."><input className={fieldClass} value={opening} maxLength={500} onChange={(e) => setOpening(e.target.value)} placeholder="e.g. Halo Pak Budi," /></Row>
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeliveryDialog({ report, senders, onClose }: { report: ReportRow; senders: { smtp: boolean; resend: boolean }; onClose: () => void }) {
  const [recipients, setRecipients] = useState(report.recipients.join("\n"));
  const [autoSend, setAuto] = useState(report.autoSend);
  const [sender, setSender] = useState<"smtp" | "resend" | "">(report.sender ?? (senders.smtp ? "smtp" : senders.resend ? "resend" : ""));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const save = () => start(async () => {
    const r = await saveReportDelivery(report.id, { recipients, autoSend, sender: sender || null });
    if (!r.ok) {
      setErrors(r.fieldErrors ?? {});
      toast.error(r.error);
      return;
    }
    toast.success(r.message ?? "Saved.");
    onClose();
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogTitle className="text-base">Delivery: {report.clientName}</DialogTitle>
        <DialogDescription>Who gets the report by email on the 1st of each month. Only owners can change this.</DialogDescription>
        <div className="flex flex-col gap-3">
          <Row label="Recipients" help="Up to 5 addresses, one per line." error={errors.recipients}>
            <textarea className={cn(fieldClass, "font-mono text-[12.5px]")} rows={4} value={recipients} onChange={(e) => setRecipients(e.target.value)} spellCheck={false} />
          </Row>
          <Row label="Sent through" error={errors.sender}>
            <select className={fieldClass} value={sender} onChange={(e) => setSender(e.target.value as "smtp" | "resend" | "")}>
              <option value="">Pick one</option>
              <option value="smtp" disabled={!senders.smtp}>Email (SMTP) channel{senders.smtp ? "" : " — not connected"}</option>
              <option value="resend" disabled={!senders.resend}>Resend{senders.resend ? "" : " — not set up"}</option>
            </select>
          </Row>
          <label className="inline-flex items-center gap-2 text-[13px]">
            <input type="checkbox" className="size-4 accent-brand" checked={autoSend} onChange={(e) => setAuto(e.target.checked)} />
            Email it automatically on the 1st (retried on the 2nd and 3rd)
          </label>
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
