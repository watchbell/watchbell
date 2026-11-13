"use server";

import { refresh } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { readBrand } from "@/lib/data/branding-db";
import { createReport, deleteReport, getReport, reportMonths, updateReportContent, updateReportDelivery } from "@/lib/data/report-db";
import { notifyEnv } from "@/lib/notify/env";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { parseReportContent, parseReportDelivery } from "@/lib/report/form";
import { makeReportPdf } from "@/lib/report/make";
import { reportMail, sendReportMail } from "@/lib/report/send";
import { timeZone } from "@/lib/time";
import { zoneDay } from "@/lib/zone-day";

// Watchbell 1.7 (spec §2.1): operators edit what a report says; owners decide who gets it and when; a test goes only
// to the person asking. Audit lines name the client, never an address. In the demo, edits stay in the visitor's own
// database and nothing is sent.

const deps = { requireActionMember };
const INVALID = "Something in that request wasn't valid.";
const UUID = /^[0-9a-f-]{36}$/i;
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);

async function audit(message: string, userId: string) {
  try {
    await recordAction({ kind: "ok", message, resourceId: null, actorUserId: userId });
  } catch {
    console.warn("audit event failed");
  }
}

export async function saveReportContent(id: string | null, form: unknown): Promise<ActionResult<{ id: string }>> {
  return runGuarded("operator", async (member): Promise<ActionResult<{ id: string }>> => {
    const f = obj(form);
    if (!f || (id !== null && !UUID.test(id))) return { ok: false, error: INVALID };
    const p = parseReportContent(f);
    if (!p.ok) return { ok: false, error: "Check the highlighted fields.", fieldErrors: p.fieldErrors };
    const quota = await limit(LIMITS.monitorWrite, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many changes. Try again in ${minutesText(quota.retryAfter)}.` };
    let saved = id;
    try {
      if (id) {
        if (!(await updateReportContent(id, p.value))) return { ok: false, error: "That report no longer exists." };
      } else saved = await createReport(p.value);
    } catch {
      return { ok: false, error: "A website in the list no longer exists. Reload the page and try again." };
    }
    await audit(`Report ${id ? "saved" : "created"}: ${p.value.clientName}`, member.userId);
    refresh();
    return { ok: true, message: "Report saved.", data: { id: saved as string } };
  }, deps, "local");
}

export async function saveReportDelivery(id: string, form: unknown): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    const f = obj(form);
    if (!f || !UUID.test(id)) return { ok: false, error: INVALID };
    const p = parseReportDelivery(f);
    if (!p.ok) return { ok: false, error: "Check the highlighted fields.", fieldErrors: p.fieldErrors };
    const report = await getReport(id);
    if (!report) return { ok: false, error: "That report no longer exists." };
    await updateReportDelivery(id, p.value);
    await audit(`Report delivery saved: ${report.clientName} (${p.value.recipients.length} recipient${p.value.recipients.length === 1 ? "" : "s"}, automatic sending ${p.value.autoSend ? "on" : "off"})`, member.userId);
    refresh();
    return { ok: true, message: p.value.autoSend ? "Saved. It's emailed on the 1st of each month." : "Saved." };
  }, deps, "local");
}

export async function deleteReportAction(id: string): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    if (!UUID.test(id)) return { ok: false, error: INVALID };
    const report = await getReport(id);
    if (!report || !(await deleteReport(id))) return { ok: false, error: "That report no longer exists." };
    await audit(`Report deleted: ${report.clientName}`, member.userId);
    refresh();
    return { ok: true, message: "Report deleted." };
  }, deps, "local");
}

// The month's report (or the month so far) to the signed-in user's own address only, with "[Test]" in the subject.
export async function sendTestReport(id: string, month: string): Promise<ActionResult> {
  return runGuarded("operator", async (member): Promise<ActionResult> => {
    if (!UUID.test(id) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { ok: false, error: INVALID };
    const zone = timeZone();
    const now = new Date();
    const offered = [zoneDay(now, zone).slice(0, 7), ...(await reportMonths(now, zone))];
    if (!offered.includes(month)) return { ok: false, error: "Pick one of the months in the list." };
    const quota = await limit(LIMITS.reportPdf, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many reports made. Try again in ${minutesText(quota.retryAfter)}.` };
    const made = await makeReportPdf(id, month, now, zone);
    if ("error" in made) return { ok: false, error: made.error === "no-sites" ? "Add a website to the report first." : made.error === "month-too-old" ? "That month's data is no longer kept." : "That report no longer exists." };
    const sender = made.report.sender ?? (notifyEnv().resendKey ? "resend" : "smtp");
    const mail = reportMail(made.report, month, await readBrand(), made, sender, [member.email]);
    const r = await sendReportMail({ ...mail, subject: `[Test] ${mail.subject}`, idempotencyKey: `report-test-${id}-${now.getTime()}` });
    if (!r.ok) return { ok: false, error: r.error };
    await audit(`Report test sent: ${made.report.clientName} (${month})`, member.userId);
    return { ok: true, message: "Test sent to your own address." };
  }, deps);
}
