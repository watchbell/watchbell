import type { IncidentLine } from "./model";

// Watchbell 1.7 (spec §2.6): the report and its email in Indonesian or English. Fixed text shipped with Watchbell; the
// owner types only the title, client name, note and email opening. A third language = one more object here.

export type ReportLang = "id" | "en";

const ID = {
  defaultTitle: "Laporan pemantauan website",
  preparedFor: "Untuk",
  page: "halaman",
  of: "dari",
  sites: "website",
  uptime: "Uptime",
  response: "Response",
  updates: "Update",
  incidents: "Gangguan",
  websites: "Website",
  site: "Website",
  down: "Tidak bisa dibuka",
  alerts: "Peringatan",
  responsePerDay: "Response per hari",
  lowerIsBetter: "Makin rendah makin baik.",
  updatesFailed: "update gagal, versi sebelumnya tetap berjalan",
  noteFrom: "Catatan dari",
  whatNumbersMean: "Arti angka-angka ini",
  meaning: "Uptime: bagian pemeriksaan (tiap menit, dari server pemantau) yang dijawab dengan baik. Response: seberapa cepat website mulai menjawab, diukur dari server pemantau; termasuk jaringan dan waktu server menyiapkan halaman.",
  dataFrom: "data mulai",
  legendOk: "semua normal",
  legendWarn: "lambat / gangguan singkat",
  legendDown: "tidak bisa dibuka",
  legendNone: "belum ada data",
  noIncidents: "Tidak ada gangguan bulan ini.",
  made: "Dibuat",
  poweredBy: "Powered by Watchbell",
  deploys: "update",
  failed: "gagal",
  weekdays: "Sen,Sel,Rab,Kam,Jum,Sab,Min",
};
const EN: typeof ID = {
  defaultTitle: "Website monitoring report",
  preparedFor: "For",
  page: "page",
  of: "of",
  sites: "websites",
  uptime: "Uptime",
  response: "Response",
  updates: "Updates",
  incidents: "Incidents",
  websites: "Websites",
  site: "Website",
  down: "Down",
  alerts: "Alerts",
  responsePerDay: "Response per day",
  lowerIsBetter: "Lower is better.",
  updatesFailed: "update failed, the previous version stayed live",
  noteFrom: "Note from",
  whatNumbersMean: "What the numbers mean",
  meaning: "Uptime: the share of checks (every minute, from our monitor) that got a good answer. Response: how fast a site starts answering, measured from the monitor; it includes the network and the time the server needs to prepare the page.",
  dataFrom: "data from",
  legendOk: "all up",
  legendWarn: "slow / short outage",
  legendDown: "could not be opened",
  legendNone: "no data yet",
  noIncidents: "No incidents this month.",
  made: "Made",
  poweredBy: "Powered by Watchbell",
  deploys: "updates",
  failed: "failed",
  weekdays: "Mon,Tue,Wed,Thu,Fri,Sat,Sun",
};
export type ReportStrings = typeof ID;

export const reportText = (lang: ReportLang): ReportStrings => (lang === "id" ? ID : EN);
const locale = (lang: ReportLang) => (lang === "id" ? "id-ID" : "en-GB");

export function formatPct(n: number | null, lang: ReportLang): string {
  if (n === null) return "—";
  // Rounded down, so a month with any downtime never reads 100%.
  const v = n >= 100 ? "100" : (Math.floor(n * 100) / 100).toFixed(2);
  return `${lang === "id" ? v.replace(".", ",") : v}%`;
}

const utcDay = (day: string) => new Date(`${day}T12:00:00Z`);
export const formatDay = (day: string, lang: ReportLang): string =>
  new Intl.DateTimeFormat(locale(lang), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(utcDay(day)).replace(/\.$/, "").replace(/(\D)\. /, "$1 ");
export const formatMonth = (month: string, lang: ReportLang): string =>
  new Intl.DateTimeFormat(locale(lang), { month: "long", year: "numeric", timeZone: "UTC" }).format(utcDay(`${month}-15`));

function when(at: Date, lang: ReportLang, zone: string): string {
  const day = new Intl.DateTimeFormat(locale(lang), { day: "numeric", month: "short", timeZone: zone }).format(at).replace(/\./g, "");
  const time = new Intl.DateTimeFormat(locale(lang), { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zone }).format(at);
  return `${day} ${lang === "id" ? time.replace(":", ".") : time.replace(".", ":")}`;
}

// "and 12 more" / "dan 12 lainnya", the line a long list ends with on the PDF (review I-6).
export const moreText = (n: number, lang: ReportLang) => (lang === "id" ? `dan ${n} lainnya` : `and ${n} more`);

export const minutes = (n: number, lang: ReportLang) => (lang === "id" ? `${n} menit` : `${n} minute${n === 1 ? "" : "s"}`);

export function incidentSentence(l: Pick<IncidentLine, "at" | "site" | "kind" | "minutes" | "endedBy">, lang: ReportLang, zone: string): string {
  const what = lang === "id"
    ? (l.kind === "down" ? `tidak bisa dibuka selama ${minutes(l.minutes, lang)}` : `lambat selama ${minutes(l.minutes, lang)}`)
    : (l.kind === "down" ? `could not be opened for ${minutes(l.minutes, lang)}` : `slow for ${minutes(l.minutes, lang)}`);
  const end = l.endedBy === "open" ? (lang === "id" ? "masih berlangsung" : "still ongoing") : (lang === "id" ? "kembali normal" : "back to normal");
  return `${when(l.at, lang, zone)} · ${l.site} · ${what} · ${end}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export function emailBody(lang: ReportLang, o: { clientName: string; month: string; opening: string | null; brand: string; title: string | null }): { subject: string; text: string; html: string } {
  const t = reportText(lang);
  const month = formatMonth(o.month, lang);
  const title = o.title?.trim() || t.defaultTitle;
  const opening = o.opening?.trim() || (lang === "id" ? `Halo tim ${o.clientName},` : `Hello ${o.clientName} team,`);
  const body = lang === "id"
    ? `Laporan bulan ${month} terlampir (PDF): uptime, gangguan, dan update website Anda.`
    : `The report for ${month} is attached (PDF): uptime, incidents and updates of your websites.`;
  const sign = lang === "id" ? `Salam,\n${o.brand}` : `Best regards,\n${o.brand}`;
  const text = `${opening}\n\n${body}\n\n${sign}\n`;
  const html = `<p>${esc(opening)}</p><p>${esc(body)}</p><p>${esc(sign).replace("\n", "<br>")}</p>`;
  return { subject: `${title} · ${month} · ${o.clientName}`, text, html };
}
