import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ saveReportContent: vi.fn(), saveReportDelivery: vi.fn(), deleteReportAction: vi.fn(), sendTestReport: vi.fn(), resendReport: vi.fn(), markReportSent: vi.fn() }));

import { ReportsView } from "./reports-view";

const report = {
  id: "123e4567-e89b-42d3-a456-426614174000", clientName: "PT Kopi Sejahtera", title: null, lang: "id" as const, note: null, emailOpening: null,
  recipients: ["owner@kopi.example"], autoSend: true, sender: "smtp" as const, sites: [{ monitorId: "m1", displayName: "Toko utama", position: 0 }],
  lastSend: { month: "2026-10", status: "sent" as const, sentAt: new Date("2026-10-31T20:01:00Z"), lastError: null },
};
const base = { reports: [report], months: [{ value: "2026-11", label: "November 2026 (so far)" }, { value: "2026-10", label: "October 2026" }], monitors: [{ id: "m1", label: "kopi-web · /" }], senders: { smtp: true, resend: false } };
const render = (role: "owner" | "operator" | "viewer", over: Record<string, unknown> = {}) => renderToStaticMarkup(h(ReportsView, { ...base, role, ...over }));

describe("ReportsView (1.7)", () => {
  it("lets a viewer download only, and shows no address to anyone in the list", () => {
    const out = render("viewer", { reports: [{ ...report, recipients: [] }] });
    expect(out).toContain("PT Kopi Sejahtera");
    expect(out).toContain("Toko utama");
    expect(out).toContain("Download PDF");
    expect(out).toContain('href="/reports/123e4567-e89b-42d3-a456-426614174000/pdf?month=2026-10&amp;lang=id"');
    for (const s of ["Edit", "Send test", "Delivery", "Delete", "New report"]) expect(out).not.toContain(s);
    expect(out).not.toContain("kopi.example");
  });

  it("gives an operator Edit and Send test but not the delivery or Delete", () => {
    const out = render("operator");
    for (const s of ["Edit", "Send test", "New report"]) expect(out).toContain(s);
    for (const s of ["Delivery", "Delete"]) expect(out).not.toContain(s);
    expect(out).toContain("Emailed on the 1st to 1 address");
    expect(out).not.toContain("kopi.example");
  });

  it("gives an owner the delivery and Delete, and says how the last send went", () => {
    const out = render("owner");
    for (const s of ["Delivery", "Delete", "Edit"]) expect(out).toContain(s);
    expect(out).toContain("October 2026 sent");
  });

  it("explains the page when there are no reports", () => {
    const out = render("owner", { reports: [] });
    expect(out).toContain("No reports yet");
    expect(out).toContain("New report");
  });
});

// Review M-11 (1.7.1).
describe("ReportsView: a month that failed (1.7.1)", () => {
  const failed = { ...report, lastSend: { month: "2026-10", status: "failed" as const, sentAt: null, lastError: "The mail server refused." } };
  it("gives the owner Send again and I sent it myself", () => {
    const out = render("owner", { reports: [failed] });
    expect(out).toContain("Send again");
    expect(out).toContain("I sent it myself");
  });
  it("gives an operator neither, and nobody the buttons for a sent month", () => {
    expect(render("operator", { reports: [failed] })).not.toContain("Send again");
    expect(render("owner")).not.toContain("Send again");
  });
});
