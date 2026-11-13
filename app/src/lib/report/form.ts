// Watchbell 1.7 (spec §2.1): the Reports page's two forms. The content operators may edit; the delivery (who gets the
// report, automatic sending, the sender) only owners may change.

export type ReportContent = {
  clientName: string; title: string | null; lang: "id" | "en"; note: string | null; emailOpening: string | null;
  sites: { monitorId: string; displayName: string; position: number }[];
};
export type ReportDelivery = { recipients: string[]; autoSend: boolean; sender: "smtp" | "resend" | null };
type Parsed<T> = { ok: true; value: T } | { ok: false; fieldErrors: Record<string, string> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
export const MAX_RECIPIENTS = 5;
export const MAX_SITES = 20;
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export function parseReportContent(f: Record<string, unknown>): Parsed<ReportContent> {
  const e: Record<string, string> = {};
  const clientName = text(f.clientName, 120);
  if (!clientName) e.clientName = "Enter the client's name.";
  const lang = f.lang === "id" || f.lang === "en" ? f.lang : null;
  if (!lang) e.lang = "Pick Indonesian or English.";
  const raw = Array.isArray(f.sites) ? f.sites : [];
  const sites: ReportContent["sites"] = [];
  const seen = new Set<string>();
  for (const s of raw.slice(0, MAX_SITES + 1)) {
    const monitorId = typeof s?.monitorId === "string" ? s.monitorId : "";
    const displayName = text(s?.displayName, 80);
    if (!UUID.test(monitorId)) { e.sites = "Something in the website list wasn't valid."; break; }
    if (!displayName) { e.sites = "Give every website a name the client will read."; break; }
    if (seen.has(monitorId)) { e.sites = "Each website can be in the report once."; break; }
    seen.add(monitorId);
    sites.push({ monitorId, displayName, position: sites.length });
  }
  if (raw.length > MAX_SITES) e.sites = `Up to ${MAX_SITES} websites in one report.`;
  if (Object.keys(e).length) return { ok: false, fieldErrors: e };
  return { ok: true, value: { clientName: clientName as string, title: text(f.title, 120), lang: lang as "id" | "en", note: text(f.note, 1000), emailOpening: text(f.emailOpening, 500), sites } };
}

export function parseReportDelivery(f: Record<string, unknown>): Parsed<ReportDelivery> {
  const e: Record<string, string> = {};
  const list = (typeof f.recipients === "string" ? f.recipients : Array.isArray(f.recipients) ? f.recipients.join(",") : "")
    .split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const bad = list.find((a) => !EMAIL.test(a) || a.length > 254);
  if (bad) e.recipients = `${bad.slice(0, 60)} isn't a valid address.`;
  else if (list.length > MAX_RECIPIENTS) e.recipients = `Up to ${MAX_RECIPIENTS} addresses.`;
  const autoSend = f.autoSend === true || f.autoSend === "on" || f.autoSend === "true";
  const sender = f.sender === "smtp" || f.sender === "resend" ? f.sender : null;
  if (autoSend && !list.length && !e.recipients) e.recipients = "Add at least one address for automatic sending.";
  if (autoSend && !sender) e.sender = "Pick how the report is emailed.";
  if (Object.keys(e).length) return { ok: false, fieldErrors: e };
  return { ok: true, value: { recipients: [...new Set(list.map((a) => a.toLowerCase()))], autoSend, sender } };
}
