import { describe, expect, it } from "vitest";
import { parseReportContent, parseReportDelivery } from "./form";

const M1 = "6f0d4c1e-7c55-4a0b-9d2e-1a2b3c4d5e6f";
const M2 = "7f0d4c1e-7c55-4a0b-9d2e-1a2b3c4d5e6f";

describe("report forms (1.7)", () => {
  it("takes the content operators may edit: client, title, language, note, opening and named sites", () => {
    const r = parseReportContent({ clientName: " PT Kopi Sejahtera ", title: "", lang: "id", note: "Catatan", emailOpening: "", sites: [{ monitorId: M1, displayName: "Toko utama" }, { monitorId: M2, displayName: "Toko online" }] });
    expect(r).toEqual({ ok: true, value: { clientName: "PT Kopi Sejahtera", title: null, lang: "id", note: "Catatan", emailOpening: null, sites: [{ monitorId: M1, displayName: "Toko utama", position: 0 }, { monitorId: M2, displayName: "Toko online", position: 1 }] } });
  });

  it("refuses a missing client, a site without a name, a site twice and an odd language", () => {
    expect(parseReportContent({ clientName: "", lang: "en", sites: [] })).toMatchObject({ ok: false, fieldErrors: { clientName: expect.any(String) } });
    expect(parseReportContent({ clientName: "A", lang: "en", sites: [{ monitorId: M1, displayName: " " }] })).toMatchObject({ ok: false, fieldErrors: { sites: expect.stringMatching(/name/) } });
    expect(parseReportContent({ clientName: "A", lang: "en", sites: [{ monitorId: M1, displayName: "x" }, { monitorId: M1, displayName: "y" }] })).toMatchObject({ ok: false, fieldErrors: { sites: expect.stringMatching(/once/) } });
    expect(parseReportContent({ clientName: "A", lang: "fr", sites: [] })).toMatchObject({ ok: false, fieldErrors: { lang: expect.any(String) } });
    expect(parseReportContent({ clientName: "A", lang: "en", sites: [{ monitorId: "nope", displayName: "x" }] })).toMatchObject({ ok: false });
  });

  it("takes the owner's delivery settings: up to five valid addresses, auto-send and the sender", () => {
    expect(parseReportDelivery({ recipients: "a@kopi.example, b@kopi.example\nc@kopi.example", autoSend: true, sender: "smtp" }))
      .toEqual({ ok: true, value: { recipients: ["a@kopi.example", "b@kopi.example", "c@kopi.example"], autoSend: true, sender: "smtp" } });
    expect(parseReportDelivery({ recipients: Array.from({ length: 6 }, (_, i) => `u${i}@x.example`).join(","), autoSend: false, sender: "resend" })).toMatchObject({ ok: false, fieldErrors: { recipients: "Up to 5 addresses." } });
    expect(parseReportDelivery({ recipients: "nope", autoSend: false, sender: "resend" })).toMatchObject({ ok: false, fieldErrors: { recipients: "nope isn't a valid address." } });
    expect(parseReportDelivery({ recipients: "", autoSend: true, sender: "resend" })).toMatchObject({ ok: false, fieldErrors: { recipients: expect.stringMatching(/automatic/) } });
    expect(parseReportDelivery({ recipients: "a@x.example", autoSend: true, sender: null })).toMatchObject({ ok: false, fieldErrors: { sender: expect.any(String) } });
  });
});
