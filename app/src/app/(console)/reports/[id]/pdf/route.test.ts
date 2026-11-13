import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";
import { DEFAULT_BRAND } from "@/lib/branding";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const member = { id: "mem-1", userId: "user-1", email: "v@example.com", role: "viewer" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), readReportInput: vi.fn(), getReport: vi.fn(), limit: vi.fn(), render: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/data/report-db", () => ({ readReportInput: h.readReportInput, getReport: h.getReport }));
vi.mock("@/lib/data/branding-db", () => ({ readBrand: async () => ({ ...DEFAULT_BRAND, name: "Studio Nusa" }), readBrandLogo: async () => null }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("@/lib/report/pdf", () => ({ renderReportPdf: h.render }));
vi.mock("@/lib/time", () => ({ timeZone: () => "Asia/Jakarta" }));

import { GET } from "./route";

const call = (query: string, id = ID) => GET(new Request(`http://x/reports/${id}/pdf${query}`), { params: Promise.resolve({ id }) });
const report = { id: ID, clientName: "PT Kopi Sejahtera", title: null, lang: "id", note: null, emailOpening: null, recipients: [], autoSend: false, sender: null, sites: [{ monitorId: "m", displayName: "Toko", position: 0 }], lastSend: null };
const input = { month: "2026-10", zone: "Asia/Jakarta", generatedAt: new Date(), sites: [], incidents: [], deploys: [], dataFrom: { uptime: null, updates: null } };

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(member);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.getReport.mockResolvedValue(report);
  h.readReportInput.mockResolvedValue(input);
  h.render.mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
});

describe("GET /reports/[id]/pdf (1.7)", () => {
  it("gives a viewer the PDF as a download named after the client and month, in the report's language", async () => {
    const res = await call("?month=2026-10");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="PT-Kopi-Sejahtera-2026-10.pdf"');
    expect(h.requireActionMember).toHaveBeenCalledWith("viewer");
    expect(h.render.mock.calls[0][1]).toMatchObject({ lang: "id", clientName: "PT Kopi Sejahtera", brand: { name: "Studio Nusa" } });
  });

  it("takes another language for one download without changing the report", async () => {
    await call("?month=2026-10&lang=en");
    expect(h.render.mock.calls[0][1].lang).toBe("en");
  });

  it("answers plainly when it can't make the PDF", async () => {
    expect((await call("?month=2026-13")).status).toBe(400);
    expect((await call("?month=2026-10&lang=fr")).status).toBe(400);
    expect((await call("?month=2026-10", "nope")).status).toBe(404);
    h.getReport.mockResolvedValue(null);
    expect((await call("?month=2026-10")).status).toBe(404);
    h.getReport.mockResolvedValue(report);
    h.readReportInput.mockResolvedValue({ error: "no-sites" });
    const ns = await call("?month=2026-10");
    expect(ns.status).toBe(422);
    expect(await ns.text()).toMatch(/no websites/i);
    h.readReportInput.mockResolvedValue({ error: "month-too-old" });
    expect(await (await call("?month=2026-01")).text()).toMatch(/no longer kept/i);
  });

  it("refuses the signed-out, and slows down a burst", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("signed-out"));
    expect((await call("?month=2026-10")).status).toBe(401);
    h.requireActionMember.mockResolvedValue(member);
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 120 });
    expect((await call("?month=2026-10")).status).toBe(429);
    expect(h.render).not.toHaveBeenCalled();
  });
});
