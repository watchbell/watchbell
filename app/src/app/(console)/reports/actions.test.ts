import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const M1 = "6f0d4c1e-7c55-4a0b-9d2e-1a2b3c4d5e6f";
const owner = { id: "mem-1", userId: "user-1", email: "owner@studio.example", role: "owner" as const };
const operator = { ...owner, id: "mem-2", userId: "user-2", email: "op@studio.example", role: "operator" as const };
const report = { id: ID, clientName: "PT Kopi Sejahtera", title: null, lang: "id", note: null, emailOpening: null, recipients: ["owner@kopi.example"], autoSend: true, sender: "smtp", sites: [{ monitorId: M1, displayName: "Toko", position: 0 }], lastSend: null };

const h = vi.hoisted(() => ({
  requireActionMember: vi.fn(), refresh: vi.fn(), recordAction: vi.fn(), limit: vi.fn(),
  createReport: vi.fn(), updateReportContent: vi.fn(), updateReportDelivery: vi.fn(), deleteReport: vi.fn(), getReport: vi.fn(), reportMonths: vi.fn(),
  makeReportPdf: vi.fn(), sendReportMail: vi.fn(), readBrand: vi.fn(), reopenFailedSend: vi.fn(), sendReportNow: vi.fn(), markSentByOwner: vi.fn(), markSend: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("next/cache", () => ({ refresh: h.refresh, revalidatePath: vi.fn() }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("@/lib/data/report-db", () => ({
  createReport: h.createReport, updateReportContent: h.updateReportContent, updateReportDelivery: h.updateReportDelivery, deleteReport: h.deleteReport, getReport: h.getReport, reportMonths: h.reportMonths,
}));
vi.mock("@/lib/report/make", () => ({ makeReportPdf: h.makeReportPdf }));
vi.mock("@/lib/report/send", async (orig) => ({ ...(await orig<typeof import("@/lib/report/send")>()), sendReportMail: h.sendReportMail, reopenFailedSend: h.reopenFailedSend, sendReportNow: h.sendReportNow, markSentByOwner: h.markSentByOwner, markSend: h.markSend }));
vi.mock("@/lib/data/branding-db", () => ({ readBrand: h.readBrand }));
vi.mock("@/lib/time", () => ({ timeZone: () => "Asia/Jakarta" }));
vi.mock("@/lib/workspace/current", () => ({ workspaceForEditing: async () => "w-kopi" }));

import { deleteReportAction, markReportSent, resendReport, saveReportContent, saveReportDelivery, sendTestReport } from "./actions";

const content = { clientName: "PT Kopi Sejahtera", lang: "id", sites: [{ monitorId: M1, displayName: "Toko" }] };

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(owner);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.getReport.mockResolvedValue(report);
  h.updateReportContent.mockResolvedValue(true);
  h.updateReportDelivery.mockResolvedValue(true);
  h.createReport.mockResolvedValue(ID);
  h.reportMonths.mockResolvedValue(["2026-10", "2026-09"]);
  h.makeReportPdf.mockResolvedValue({ bytes: new Uint8Array([1]), filename: "PT-Kopi-Sejahtera-2026-10.pdf", report });
  h.sendReportMail.mockResolvedValue({ ok: true });
  h.readBrand.mockResolvedValue({ name: null, accent: null, senderName: null, publicUrl: null, poweredBy: true, hasLogo: false });
});

describe("Reports actions (1.7)", () => {
  it("lets an operator edit the content", async () => {
    h.requireActionMember.mockResolvedValue(operator);
    expect((await saveReportContent(ID, content)).ok).toBe(true);
    expect(h.requireActionMember).toHaveBeenCalledWith("operator");
    expect(h.updateReportContent).toHaveBeenCalledWith(ID, expect.objectContaining({ clientName: "PT Kopi Sejahtera", sites: [{ monitorId: M1, displayName: "Toko", position: 0 }] }));
    expect((await saveReportContent(null, content)).ok).toBe(true);
    expect(h.createReport.mock.calls[0][1]).toBe("w-kopi"); // 1.8: a new report lands in the workspace shown
    expect(h.createReport).toHaveBeenCalled();
  });

  it("refuses an empty site name before saving", async () => {
    const r = await saveReportContent(ID, { ...content, sites: [{ monitorId: M1, displayName: " " }] });
    expect(r).toMatchObject({ ok: false, fieldErrors: { sites: expect.any(String) } });
    expect(h.updateReportContent).not.toHaveBeenCalled();
  });

  it("only an owner changes who receives a report", async () => {
    h.requireActionMember.mockImplementation(async (min: string) => {
      if (min === "owner") throw new AuthError("forbidden");
      return operator;
    });
    const r = await saveReportDelivery(ID, { recipients: "boss@kopi.example", autoSend: true, sender: "smtp" });
    expect(r).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.updateReportDelivery).not.toHaveBeenCalled();
    expect((await deleteReportAction(ID)).ok).toBe(false);
  });

  it("refuses six recipients", async () => {
    const r = await saveReportDelivery(ID, { recipients: Array.from({ length: 6 }, (_, i) => `u${i}@kopi.example`).join(","), autoSend: false, sender: "smtp" });
    expect(r).toMatchObject({ ok: false, fieldErrors: { recipients: "Up to 5 addresses." } });
  });

  it("sends a test only to the person asking, never to the report's recipients", async () => {
    h.requireActionMember.mockResolvedValue(operator);
    const r = await sendTestReport(ID, "2026-10");
    expect(r.ok).toBe(true);
    const mail = h.sendReportMail.mock.calls[0][0];
    expect(mail.to).toEqual(["op@studio.example"]);
    expect(mail.subject).toMatch(/^\[Test\] /);
    expect(JSON.stringify(h.recordAction.mock.calls)).not.toMatch(/kopi\.example/);
  });

  it("refuses a test for a month that isn't offered", async () => {
    expect(await sendTestReport(ID, "2025-01")).toMatchObject({ ok: false });
    expect(h.sendReportMail).not.toHaveBeenCalled();
  });
});

// Review M-11 (1.7.1).
describe("Send again / I sent it myself (1.7.1)", () => {
  it("are the owner's: an operator gets the owner message", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect((await resendReport(ID, "2026-10")).ok).toBe(false);
    expect((await markReportSent(ID, "2026-10")).ok).toBe(false);
    expect(h.reopenFailedSend).not.toHaveBeenCalled();
    expect(h.markSentByOwner).not.toHaveBeenCalled();
  });

  it("Send again refuses a month that didn't fail, and sends one that did", async () => {
    h.reopenFailedSend.mockResolvedValue(false);
    expect(await resendReport(ID, "2026-10")).toEqual({ ok: false, error: "Only a month that failed can be sent again." });
    expect(h.sendReportNow).not.toHaveBeenCalled();
    h.reopenFailedSend.mockResolvedValue(true);
    h.sendReportNow.mockResolvedValue({ status: "sent" });
    expect(await resendReport(ID, "2026-10")).toMatchObject({ ok: true });
    expect(h.recordAction.mock.calls.at(-1)?.[0].message).toBe("Report sent again: PT Kopi Sejahtera (2026-10)");
    expect(JSON.stringify(h.recordAction.mock.calls)).not.toContain("kopi.example");
  });

  it("Send again says why it didn't go", async () => {
    h.reopenFailedSend.mockResolvedValue(true);
    h.sendReportNow.mockResolvedValue({ status: "failed", error: "Timed out." });
    expect(await resendReport(ID, "2026-10")).toEqual({ ok: false, error: "Not sent: Timed out." });
  });

  it("I sent it myself marks a failed month and names the client in the audit line", async () => {
    h.markSentByOwner.mockResolvedValue(true);
    expect(await markReportSent(ID, "2026-10")).toMatchObject({ ok: true });
    expect(h.recordAction.mock.calls.at(-1)?.[0].message).toBe("Report marked as sent: PT Kopi Sejahtera (2026-10)");
    h.markSentByOwner.mockResolvedValue(false);
    expect(await markReportSent(ID, "2026-10")).toEqual({ ok: false, error: "Only a month that failed can be marked as sent." });
  });
});

// Final review: a Send again that breaks part-way never leaves the month "claimed" (the alert would close and nothing
// would retry it): it is marked failed as "may have been sent", so the owner checks with the client.
describe("Send again that breaks part-way (1.7.1)", () => {
  it("marks the month failed with the unknown-outcome reason", async () => {
    h.reopenFailedSend.mockResolvedValue(true);
    h.sendReportNow.mockRejectedValue(new Error("connection reset"));
    const r = await resendReport(ID, "2026-10");
    expect(r).toEqual({ ok: false, error: "The send stopped part-way and may have been sent. Check with the client before sending it again." });
    expect(h.markSend).toHaveBeenCalledWith(ID, "2026-10", { status: "failed", error: expect.stringMatching(/may have been sent/) }, expect.any(Date));
  });
});
