import "server-only";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { reportSends } from "@/db/report-schema";
import { addressOf, type Brand, brandIconPath, mailFrom } from "@/lib/branding";
import { readBrand } from "@/lib/data/branding-db";
import { readChannel } from "@/lib/data/notify-db";
import { listReports, type ReportRow } from "@/lib/data/report-db";
import { serverEnv } from "@/lib/env";
import { notifyEnv } from "@/lib/notify/env";
import { sendEmail } from "@/lib/notify/resend";
import { sendSmtp } from "@/lib/notify/smtp";
import type { SendResult } from "@/lib/notify/telegram";
import { timeZone } from "@/lib/time";
import { zoneDay } from "@/lib/zone-day";
import { emailBody, reportText } from "./i18n";
import { type MakeError, makeReportPdf } from "./make";

// Watchbell 1.7 (spec §6): on the 1st of a month (install zone) the daily job emails each report that has automatic
// sending on, for the month just ended, with the PDF attached. A failed try is retried on the 2nd and 3rd; after that
// the month is marked failed and the ReportSendFailed alert tells the owner. One claim per report and month (an upsert
// that only takes a free row), so two runs racing never send twice. Recipients never reach a log line.

const CLAIM_HOLD_MS = 10 * 60_000;
const LAST_RETRY_DAY = 3;

const prevMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

export function dueReportSends(now: Date, zone: string): { month: string; day: number; due: boolean } {
  const today = zoneDay(now, zone);
  const day = Number(today.slice(8, 10));
  return { month: prevMonth(today.slice(0, 7)), day, due: day >= 1 && day <= LAST_RETRY_DAY };
}

// True only for the run that took the row: a new month, or a try that failed (marked, so its claim was released).
// A claim still held is another run's, or one that died part-way (settleStaleClaims), and is never taken again.
export async function claimSend(reportId: string, month: string, now: Date): Promise<boolean> {
  const rows = await db().insert(reportSends).values({ reportId, month, status: "claimed", attempts: 1, claimedAt: now })
    .onConflictDoUpdate({
      target: [reportSends.reportId, reportSends.month],
      set: { status: "claimed", claimedAt: now, attempts: sql`${reportSends.attempts} + 1` },
      setWhere: and(eq(reportSends.status, "claimed"), isNull(reportSends.claimedAt)),
    })
    .returning({ reportId: reportSends.reportId });
  return rows.length > 0;
}

export const UNKNOWN_OUTCOME = "The send stopped part-way and may have been sent. Check with the client before sending it yourself.";

// Review I-3: a claim held longer than a run lasts belongs to a run that died after (or while) mailing. Sending again
// could reach the client twice, so the month is marked failed and the alert asks the owner to check. Returns how many.
export async function settleStaleClaims(now: Date): Promise<number> {
  const rows = await db().update(reportSends).set({ status: "failed", claimedAt: null, lastError: UNKNOWN_OUTCOME })
    .where(and(eq(reportSends.status, "claimed"), lt(reportSends.claimedAt, new Date(now.getTime() - CLAIM_HOLD_MS))))
    .returning({ reportId: reportSends.reportId });
  return rows.length;
}

export type SendOutcome = { status: "sent" } | { status: "retry" | "failed"; error: string };

export async function markSend(reportId: string, month: string, o: SendOutcome, now: Date): Promise<void> {
  const set = o.status === "sent"
    ? { status: "sent" as const, sentAt: now, lastError: null, claimedAt: null }
    : { status: o.status === "failed" ? ("failed" as const) : ("claimed" as const), claimedAt: null, lastError: o.error.slice(0, 300) };
  await db().update(reportSends).set(set).where(and(eq(reportSends.reportId, reportId), eq(reportSends.month, month)));
}

export type ReportMail = {
  sender: "smtp" | "resend"; to: string[]; subject: string; text: string; html: string; pdf: Uint8Array; filename: string; fromName: string | null; idempotencyKey: string;
};

// Through the install's own mail: the SMTP channel (to the report's recipients, not the alert address) or Resend.
export async function sendReportMail(m: ReportMail): Promise<SendResult> {
  if (m.sender === "smtp") {
    const sm = await readChannel("smtp");
    if (!sm?.config?.host) return { ok: false, kind: "config", error: "Email (SMTP) isn't connected." };
    return sendSmtp({ ...sm.config, to: m.to.join(", ") }, m.subject, m.text, {}, { fromName: m.fromName, attachment: { filename: m.filename, contentType: "application/pdf", data: m.pdf } });
  }
  const env = notifyEnv();
  if (!env.resendKey || !env.digestFrom) return { ok: false, kind: "config", error: "Resend isn't set up (RESEND_API_KEY and DIGEST_FROM)." };
  const from = m.fromName ? mailFrom(m.fromName, addressOf(env.digestFrom)) : env.digestFrom;
  return sendEmail(env.resendKey, {
    from, to: m.to, subject: m.subject, html: m.html, text: m.text, idempotencyKey: m.idempotencyKey,
    attachments: [{ filename: m.filename, content: Buffer.from(m.pdf).toString("base64") }],
  });
}

const MAKE_ERROR: Record<MakeError["error"], string> = {
  "not-found": "The report no longer exists.",
  "no-sites": "The report has no websites.",
  "month-too-old": "That month's data is no longer kept.",
  "render-failed": "The PDF couldn't be made.",
};

// The report email: subject, opening and body in the report's language, signed with the brand, Powered by when on.
// `siteUrl`: where the console is reached (SITE_URL); the brand's public address wins (review I-8). The logo is loaded
// from it, so the email carries no attachment besides the PDF.
export function reportMail(
  r: ReportRow, month: string, brand: Brand, made: { bytes: Uint8Array; filename: string }, sender: "smtp" | "resend",
  to: string[] = r.recipients, siteUrl?: string,
): ReportMail {
  const name = brand.name ?? brand.senderName ?? "Watchbell";
  const body = emailBody(r.lang, { clientName: r.clientName, month, opening: r.emailOpening, brand: name, title: r.title });
  const powered = brand.poweredBy ? reportText(r.lang).poweredBy : null;
  // The address is read only when there is a logo to show.
  const base = brand.hasLogo ? (brand.publicUrl ?? siteUrl ?? serverEnv().SITE_URL).replace(/\/+$/, "") : "";
  const logo = brand.hasLogo ? `<p><img src="${base}${brandIconPath(brand.logoVersion)}" width="40" height="40" alt="" style="border-radius:6px"></p>` : "";
  return {
    sender, to, subject: body.subject, fromName: brand.senderName,
    text: powered ? `${body.text}\n--\n${powered}\n` : body.text,
    html: `${logo}${body.html}${powered ? `<p style="color:#8a8f9c;font-size:12px">${powered}</p>` : ""}`,
    pdf: made.bytes, filename: made.filename, idempotencyKey: `report-${r.id}-${month}`,
  };
}

export type SendIo = {
  zone: string;
  list: () => Promise<ReportRow[]>;
  claim: (id: string, month: string, now: Date) => Promise<boolean>;
  settle: (now: Date) => Promise<number>;
  make: (id: string, month: string, now: Date, zone: string) => Promise<{ bytes: Uint8Array; filename: string } | MakeError>;
  mail: (m: ReportMail) => Promise<SendResult>;
  brand: () => Promise<Brand>;
  mark: (id: string, month: string, o: SendOutcome, now: Date) => Promise<void>;
};

const defaultIo = (): SendIo => ({
  zone: timeZone(), list: listReports, claim: claimSend, settle: settleStaleClaims, make: makeReportPdf, mail: sendReportMail, brand: readBrand, mark: markSend,
});

// One report and month: claim it, make the PDF, mail it, record the outcome. `last`: a failure is final ("failed")
// rather than a try the next run repeats. "busy": another run holds the claim, nothing was sent.
export async function sendReportNow(
  r: ReportRow, month: string, now: Date, io: SendIo = defaultIo(), last = true, brand?: Brand,
): Promise<SendOutcome | { status: "busy" }> {
  if (!(await io.claim(r.id, month, now))) return { status: "busy" };
  const giveUp = (error: string): SendOutcome => ({ status: last ? "failed" : "retry", error });
  const made = await io.make(r.id, month, now, io.zone).catch((): MakeError => ({ error: "render-failed" }));
  if ("error" in made) {
    const o = giveUp(MAKE_ERROR[made.error]);
    await io.mark(r.id, month, o, now);
    return o;
  }
  const res = await io.mail(reportMail(r, month, brand ?? (await io.brand()), made, r.sender as "smtp" | "resend")).catch((): SendResult => ({ ok: false, kind: "transient", error: "The mail couldn't be sent." }));
  const o: SendOutcome = res.ok ? { status: "sent" } : giveUp(res.error);
  await io.mark(r.id, month, o, now);
  return o;
}

// Review M-11 (1.7.1): the owner sends a month that failed again. Only a failed month reopens (its claim freed), so the
// send then takes the claim like any run, and a run racing it can't send twice.
export async function reopenFailedSend(reportId: string, month: string): Promise<boolean> {
  const rows = await db().update(reportSends).set({ status: "claimed", claimedAt: null })
    .where(and(eq(reportSends.reportId, reportId), eq(reportSends.month, month), eq(reportSends.status, "failed")))
    .returning({ reportId: reportSends.reportId });
  return rows.length > 0;
}

// Review M-11 (1.7.1): "I sent it myself": a failed month is marked sent, so the ReportSendFailed alert resolves.
export async function markSentByOwner(reportId: string, month: string, now: Date): Promise<boolean> {
  const rows = await db().update(reportSends).set({ status: "sent", sentAt: now, lastError: null, claimedAt: null })
    .where(and(eq(reportSends.reportId, reportId), eq(reportSends.month, month), eq(reportSends.status, "failed")))
    .returning({ reportId: reportSends.reportId });
  return rows.length > 0;
}

// `deadline` (ms since epoch): no new report starts after it; the rest wait for the next run (review I-3).
export async function runReportSends(now: Date, io: SendIo = defaultIo(), deadline = Number.POSITIVE_INFINITY): Promise<{ sent: number; failed: number; left: number }> {
  const { month, day, due } = dueReportSends(now, io.zone);
  const out = { sent: 0, failed: 0, left: 0 };
  if (!due) return out;
  await io.settle(now);
  // A report without websites is not skipped: it fails like any other and the alert tells the owner (review I-5).
  const list = (await io.list()).filter((r) => r.autoSend && r.recipients.length > 0 && r.sender);
  if (!list.length) return out;
  const brand = await io.brand();
  for (const [i, r] of list.entries()) {
    if (Date.now() > deadline) {
      out.left = list.length - i;
      break;
    }
    const o = await sendReportNow(r, month, now, io, day >= LAST_RETRY_DAY, brand);
    if (o.status === "sent") out.sent++;
    else if (o.status !== "busy") out.failed++;
  }
  return out;
}
