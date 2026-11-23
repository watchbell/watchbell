import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFImage, type PDFPage, rgb } from "pdf-lib";
import { type Brand, displayName } from "@/lib/branding";
import { chartShownText, dayLineSentence, formatDay, formatMonth, formatPct, incidentSentence, meaningText, minutes, moreText, type ReportLang, reportText, zoneText } from "./i18n";
import type { DayTone, ReportModel } from "./model";

// Watchbell 1.7 (spec §2.4, design C): the monthly client report as a two-page A4 PDF, drawn with pdf-lib (no browser,
// so the cloud console's CPU stays low). Every string drawn goes through `text()`, which also feeds `trace` for tests.

export type RenderOptions = {
  brand: Brand;
  lang: ReportLang;
  zone: string;
  clientName: string;
  title: string | null;
  note: string | null;
  generatedAt: Date;
  logo?: Uint8Array | null;
};

const W = 595.28;
const H = 841.89;
const M = 40; // page margin
const DEFAULT_ACCENT = "#1f45c9";
const INK = rgb(0.086, 0.094, 0.114);
const SOFT = rgb(0.357, 0.38, 0.439);
const FAINT = rgb(0.541, 0.561, 0.612);
const RULE = rgb(0.902, 0.91, 0.925);
const TONE: Record<DayTone, ReturnType<typeof rgb>> = {
  ok: rgb(0.863, 0.988, 0.906), warn: rgb(0.992, 0.902, 0.541), down: rgb(0.996, 0.792, 0.792), none: rgb(0.953, 0.957, 0.965),
};
const SERIES = ["#1f45c9", "#9ca3af", "#b45309", "#0f766e", "#6b7280"];

const hex = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);

let fontBytes: Promise<[Buffer, Buffer, Buffer]> | null = null;
// Read once per process. The fonts ship next to this file (OFL); next.config traces them into the server output.
function fonts(): Promise<[Buffer, Buffer, Buffer]> {
  const dir = path.join(process.cwd(), "src", "lib", "report", "fonts");
  fontBytes ??= Promise.all(["Geist-Regular.ttf", "Geist-SemiBold.ttf", "GeistMono-Regular.ttf"].map((f) => readFile(path.join(dir, f)))) as Promise<[Buffer, Buffer, Buffer]>;
  return fontBytes;
}

type Ctx = { page: PDFPage; regular: PDFFont; bold: PDFFont; mono: PDFFont; accent: ReturnType<typeof rgb>; month: string; trace?: string[] };

// Nothing may be drawn into the footer band (review I-6): a list that would reach it must stop first.
const BOTTOM = M + 24;

function text(c: Ctx, s: string, x: number, y: number, o: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; right?: boolean } = {}) {
  if (y < BOTTOM && y > M + 2) throw new Error(`report PDF overflow at y=${Math.round(y)}: "${s.slice(0, 40)}"`);
  const size = o.size ?? 9.5;
  const font = o.font ?? c.regular;
  const w = font.widthOfTextAtSize(s, size);
  c.page.drawText(s, { x: o.right ? x - w : x, y, size, font, color: o.color ?? INK });
  c.trace?.push(s);
  return w;
}

// 1.8.3: a text cut to `width` with "…" (a long client name in the header).
function fit(font: PDFFont, s: string, size: number, width: number): string {
  if (font.widthOfTextAtSize(s, size) <= width) return s;
  let out = s;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > width) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

// 1.8.4: one word wider than the line (a pasted link) is cut into pieces that fit, so it never runs past the margin.
function splitWord(font: PDFFont, word: string, size: number, width: number): string[] {
  if (font.widthOfTextAtSize(word, size) <= width) return [word];
  const out: string[] = [];
  let piece = "";
  for (const ch of word) {
    if (piece && font.widthOfTextAtSize(piece + ch, size) > width) {
      out.push(piece);
      piece = ch;
    } else piece += ch;
  }
  if (piece) out.push(piece);
  return out;
}

// Greedy word wrap; returns the y after the last line. `maxLines` cuts a long text with "…" (review I-6).
function para(c: Ctx, s: string, x: number, y: number, width: number, o: { size?: number; color?: ReturnType<typeof rgb>; lead?: number; maxLines?: number } = {}): number {
  const size = o.size ?? 9.5;
  const lead = o.lead ?? size * 1.45;
  const lines: string[] = [];
  let line = "";
  for (const word of s.split(/\s+/).flatMap((w) => splitWord(c.regular, w, size, width))) {
    const next = line ? `${line} ${word}` : word;
    if (c.regular.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  const max = o.maxLines ?? lines.length;
  lines.slice(0, max).forEach((l, i) => {
    text(c, i === max - 1 && lines.length > max ? `${l} …` : l, x, y, { size, color: o.color });
    y -= lead;
  });
  return y;
}

// One line per item while there is room above `floor`; the rest becomes "and N more" (review I-6).
function lines(c: Ctx, items: string[], y: number, floor: number, lang: ReportLang, max = Number.POSITIVE_INFINITY): number {
  const lead = 9.5 * 1.45;
  for (const [i, s] of items.entries()) {
    const room = items.length - i > 1 ? y - 2 * lead >= floor : y - lead >= floor;
    if (i >= max || !room) {
      text(c, moreText(items.length - i, lang), M, y, { color: SOFT });
      return y - lead;
    }
    y = para(c, s, M, y, W - 2 * M, { maxLines: 1 });
  }
  return y;
}

function header(c: Ctx, o: RenderOptions, logo: PDFImage | null, page: number): number {
  const t = reportText(o.lang);
  const y = H - M - 26;
  if (logo) c.page.drawImage(logo, { x: M, y, width: 26, height: 26 });
  else {
    c.page.drawRectangle({ x: M, y, width: 26, height: 26, color: c.accent });
    const initials = displayName(o.brand).split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    text(c, initials, M + 13 - c.bold.widthOfTextAtSize(initials, 10) / 2, y + 9, { size: 10, font: c.bold, color: rgb(1, 1, 1) });
  }
  // 1.8.4: the brand and the title (up to 120 characters) stay in the left half, clear of the month and the client line.
  const leftRoom = (W - 2 * M) / 2 - 34 - 8;
  text(c, fit(c.bold, displayName(o.brand), 13, leftRoom), M + 34, y + 14, { size: 13, font: c.bold });
  text(c, fit(c.regular, o.title?.trim() || t.defaultTitle, 9, leftRoom), M + 34, y + 2, { size: 9, color: SOFT });
  text(c, formatMonth(c.month, o.lang), W - M, y + 14, { size: 11, font: c.bold, right: true });
  // 1.8.3: a long client name is cut so the right-aligned line never runs into the brand on the left.
  const pageOf = ` · ${t.page} ${page} ${t.of} 2`;
  const nameRoom = (W - 2 * M) / 2 - c.regular.widthOfTextAtSize(`${t.preparedFor} ${pageOf}`, 9);
  text(c, `${t.preparedFor} ${fit(c.regular, o.clientName, 9, nameRoom)}${pageOf}`, W - M, y + 2, { size: 9, color: SOFT, right: true });
  c.page.drawLine({ start: { x: M, y: y - 8 }, end: { x: W - M, y: y - 8 }, thickness: 1.5, color: c.accent });
  return y - 26;
}

function footer(c: Ctx, o: RenderOptions) {
  const t = reportText(o.lang);
  const made = new Intl.DateTimeFormat(o.lang === "id" ? "id-ID" : "en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: o.zone }).format(o.generatedAt);
  c.page.drawLine({ start: { x: M, y: M + 14 }, end: { x: W - M, y: M + 14 }, thickness: 0.5, color: RULE });
  text(c, `${t.made} ${made}`, M, M, { size: 8, color: FAINT });
  if (o.brand.poweredBy) text(c, t.poweredBy, W - M, M, { size: 8, color: FAINT, right: true });
}

function calendar(c: Ctx, m: ReportModel, o: RenderOptions, top: number): number {
  const t = reportText(o.lang);
  const gap = 4;
  const cw = (W - 2 * M - 6 * gap) / 7;
  const ch = 30;
  t.weekdays.split(",").forEach((d, i) => text(c, d, M + i * (cw + gap) + cw / 2 - c.regular.widthOfTextAtSize(d, 8.5) / 2, top, { size: 8.5, color: SOFT }));
  const firstDow = (new Date(`${m.days[0].day}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  let y = top - 8 - ch;
  m.days.forEach((d, i) => {
    const slot = firstDow + i;
    const col = slot % 7;
    const row = Math.floor(slot / 7);
    const x = M + col * (cw + gap);
    const yy = y - row * (ch + gap);
    c.page.drawRectangle({ x, y: yy, width: cw, height: ch, color: TONE[d.tone] });
    const n = String(i + 1);
    text(c, n, x + cw / 2 - c.regular.widthOfTextAtSize(n, 10) / 2, yy + ch / 2 - 3.5, { size: 10, font: d.tone === "warn" || d.tone === "down" ? c.bold : c.regular });
  });
  const rows = Math.ceil((firstDow + m.days.length) / 7);
  y = y - (rows - 1) * (ch + gap) - 16;
  let x = M;
  for (const [tone, label] of [["ok", t.legendOk], ["warn", t.legendWarn], ["down", t.legendDown], ["none", t.legendNone]] as const) {
    c.page.drawRectangle({ x, y: y - 1, width: 8, height: 8, color: TONE[tone] });
    x += 12 + text(c, label, x + 12, y, { size: 8.5, color: SOFT }) + 14;
  }
  return y - 20;
}

function sitesTable(c: Ctx, m: ReportModel, o: RenderOptions, top: number): number {
  const t = reportText(o.lang);
  text(c, t.websites, M, top, { size: 11, font: c.bold });
  let y = top - 16;
  const cols = [M, M + 250, M + 340, M + 420];
  [t.site, t.uptime, t.down, t.response].forEach((h, i) => text(c, h, cols[i], y, { size: 8.5, color: SOFT }));
  y -= 14;
  for (const [i, s] of m.sites.entries()) {
    if (y - 15 < BOTTOM + 4 && i < m.sites.length - 1) {
      text(c, moreText(m.sites.length - i, o.lang), cols[0], y, { color: SOFT });
      return y - 15;
    }
    c.page.drawLine({ start: { x: M, y: y + 10 }, end: { x: W - M, y: y + 10 }, thickness: 0.5, color: RULE });
    text(c, s.dataFrom ? `${s.name} (${t.dataFrom} ${formatDay(s.dataFrom, o.lang)})` : s.name, cols[0], y);
    text(c, formatPct(s.uptimePct, o.lang), cols[1], y, { font: c.mono });
    text(c, s.downMinutes ? minutes(s.downMinutes, o.lang) : "—", cols[2], y, { font: c.mono });
    text(c, s.p50Ms === null ? "—" : `${s.p50Ms} ms`, cols[3], y, { font: c.mono });
    y -= 15;
  }
  return y - 6;
}

function pageOne(c: Ctx, m: ReportModel, o: RenderOptions, logo: PDFImage | null) {
  const t = reportText(o.lang);
  let y = header(c, o, logo, 1);
  // Review M-5: the zone every time in the report is in (its name in the middle of the month).
  // 1.8.3: wrapped (two lines at most) so a long client name stays inside the margins; the calendar follows it.
  const lead = 9.5 * 1.45;
  y = para(c, `${t.preparedFor} ${o.clientName} · ${m.sites.length} ${t.sites} · ${zoneText(o.zone, o.lang, new Date(`${m.month}-15T12:00:00Z`))}`, M, y, W - 2 * M, { size: 9.5, color: SOFT, lead, maxLines: 2 });
  y = calendar(c, m, o, y + lead - 22);
  text(c, t.incidents, M, y, { size: 11, font: c.bold });
  y -= 16;
  // Review M-3: page 1 explains the coloured days (per site); the incidents themselves are listed on page 2.
  if (!m.dayLines.length) y = para(c, t.noIncidents, M, y, W - 2 * M, { color: SOFT });
  // At most 6 here, leaving room for the numbers and at least a few websites.
  // Days that couldn't be opened come first, so "and N more" only ever hides the milder ones; each group by date.
  const ordered = [...m.dayLines.filter((l) => l.tone === "down"), ...m.dayLines.filter((l) => l.tone !== "down")];
  y = lines(c, ordered.map((l) => dayLineSentence(l, o.lang)), y, BOTTOM + 150, o.lang, 6);
  y -= 8;
  const nums: [string, string][] = [
    [t.uptime, formatPct(m.summary.uptimePct, o.lang)],
    [t.response, m.summary.p50Ms === null ? "—" : `${m.summary.p50Ms} ms`],
    [t.updates, `${m.summary.updates.ok + m.summary.updates.failed}${m.summary.updates.failed ? ` · ${m.summary.updates.failed} ${t.failed}` : ""}`],
  ];
  const bw = (W - 2 * M - 16) / 3;
  nums.forEach(([label, value], i) => {
    const x = M + i * (bw + 8);
    c.page.drawRectangle({ x, y: y - 34, width: bw, height: 42, borderColor: RULE, borderWidth: 0.8 });
    text(c, label, x + 8, y - 4, { size: 8.5, color: SOFT });
    // Review M-6: the month's uptime only counts from the first day anything was measured.
    if (i === 0 && m.summary.dataFrom) text(c, `${t.dataFrom} ${formatDay(m.summary.dataFrom, o.lang)}`, x + bw - 8, y - 4, { size: 7.5, color: FAINT, right: true });
    text(c, value, x + 8, y - 24, { size: 15, font: c.mono });
  });
  y -= 60;
  sitesTable(c, m, o, y);
  footer(c, o);
}

function responseChart(c: Ctx, m: ReportModel, o: RenderOptions, top: number): number {
  const t = reportText(o.lang);
  text(c, t.responsePerDay, M, top, { size: 11, font: c.bold });
  const h = 110;
  const y0 = top - 16 - h;
  const w = W - 2 * M;
  const all = m.responseSeries.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const max = Math.max(1, ...all);
  c.page.drawLine({ start: { x: M, y: y0 }, end: { x: M + w, y: y0 }, thickness: 0.5, color: RULE });
  text(c, `${max} ms`, M, y0 + h + 2, { size: 7.5, color: FAINT });
  m.responseSeries.slice(0, SERIES.length).forEach((s, si) => {
    const n = s.values.length;
    let prev: { x: number; y: number } | null = null;
    s.values.forEach((v, i) => {
      if (v === null) {
        prev = null;
        return;
      }
      const pt = { x: M + (n > 1 ? (i / (n - 1)) * w : 0), y: y0 + (v / max) * h };
      if (prev) c.page.drawLine({ start: prev, end: pt, thickness: 1.3, color: hex(si === 0 && o.brand.accent ? o.brand.accent : SERIES[si]) });
      prev = pt;
    });
  });
  // Owner's test (T-2): day labels, so a line that starts mid-month reads as such.
  const n = m.days.length;
  for (const i of [0, 7, 14, 21, n - 1]) {
    const label = String(i + 1);
    text(c, label, M + (n > 1 ? (i / (n - 1)) * w : 0) - c.regular.widthOfTextAtSize(label, 7.5) / 2, y0 - 10, { size: 7.5, color: FAINT });
  }
  let x = M;
  let ly = y0 - 24;
  m.responseSeries.slice(0, SERIES.length).forEach((s, si) => {
    c.page.drawRectangle({ x, y: ly + 2, width: 10, height: 2.5, color: hex(si === 0 && o.brand.accent ? o.brand.accent : SERIES[si]) });
    x += 14 + text(c, s.name, x + 14, ly, { size: 8.5, color: SOFT }) + 12;
  });
  // Review M-4: the chart draws a few lines only; say how many of the websites it shows.
  if (m.responseSeries.length > SERIES.length) {
    ly -= 13;
    text(c, chartShownText(SERIES.length, m.responseSeries.length, o.lang), M, ly, { size: 8.5, color: SOFT });
  }
  return para(c, t.lowerIsBetter, M, ly - 14, w, { size: 8.5, color: FAINT }) - 6;
}

function pageTwo(c: Ctx, m: ReportModel, o: RenderOptions, logo: PDFImage | null) {
  const t = reportText(o.lang);
  let y = header(c, o, logo, 2);
  y = responseChart(c, m, o, y);
  text(c, t.updates, M, y, { size: 11, font: c.bold });
  y -= 16;
  if (m.dataFrom.updates) y = para(c, `${t.dataFrom} ${formatDay(m.dataFrom.updates, o.lang)}`, M, y, W - 2 * M, { size: 8.5, color: FAINT });
  // Room is kept for the alerts, the note and what the numbers mean below.
  const updatesFloor = BOTTOM + 200;
  for (const [i, u] of m.updates.entries()) {
    if (y - 15 < updatesFloor && i < m.updates.length - 1) {
      text(c, moreText(m.updates.length - i, o.lang), M, y, { color: SOFT });
      y -= 15;
      break;
    }
    text(c, u.name, M, y);
    text(c, `${u.ok + u.failed} ${t.deploys}${u.failed ? ` · ${u.failed} ${t.updatesFailed}` : ""}`, M + 250, y, { color: u.failed ? SOFT : INK });
    y -= 15;
  }
  y -= 8;
  text(c, t.alerts, M, y, { size: 11, font: c.bold });
  y -= 16;
  if (!m.incidents.length) y = para(c, t.noIncidents, M, y, W - 2 * M, { color: SOFT });
  const noteRoom = o.note?.trim() ? 24 + 4 * 9.5 * 1.45 + 8 : 0;
  y = lines(c, m.incidents.map((l) => incidentSentence(l, o.lang, o.zone)), y, BOTTOM + noteRoom + 64, o.lang);
  if (o.note?.trim()) {
    y -= 8;
    text(c, `${t.noteFrom} ${displayName(o.brand)}`, M, y, { size: 11, font: c.bold });
    y -= 16;
    c.page.drawRectangle({ x: M, y: y - 2, width: 2.5, height: 12, color: c.accent });
    y = para(c, o.note.trim(), M + 10, y, W - 2 * M - 10, { maxLines: 4 });
  }
  y -= 8;
  text(c, t.whatNumbersMean, M, y, { size: 11, font: c.bold });
  para(c, meaningText(o.lang, m.intervals), M, y - 16, W - 2 * M, { size: 9, color: SOFT });
  footer(c, o);
}

export async function renderReportPdf(m: ReportModel, o: RenderOptions, trace?: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const [r, b, mo] = await fonts();
  const [regular, bold, mono] = await Promise.all([doc.embedFont(r, { subset: true }), doc.embedFont(b, { subset: true }), doc.embedFont(mo, { subset: true })]);
  const logo = o.logo ? await doc.embedPng(o.logo).catch(() => null) : null;
  doc.setTitle(`${o.title?.trim() || reportText(o.lang).defaultTitle} · ${formatMonth(m.month, o.lang)} · ${o.clientName}`);
  doc.setAuthor(displayName(o.brand));
  doc.setProducer("Watchbell");
  doc.setCreator("Watchbell");
  const accent = hex(o.brand.accent ?? DEFAULT_ACCENT);
  const p1 = doc.addPage([W, H]);
  pageOne({ page: p1, regular, bold, mono, accent, month: m.month, trace }, m, o, logo);
  const p2 = doc.addPage([W, H]);
  pageTwo({ page: p2, regular, bold, mono, accent, month: m.month, trace }, m, o, logo);
  return doc.save();
}
