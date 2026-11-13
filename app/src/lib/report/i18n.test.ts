import { describe, expect, it } from "vitest";
import { emailBody, formatDay, formatMonth, formatPct, incidentSentence, reportText } from "./i18n";

const Z = "Asia/Jakarta";

describe("report wording (1.7, Indonesian and English)", () => {
  it("formats numbers, days and months the way each language writes them", () => {
    expect(formatPct(99.94, "id")).toBe("99,94%");
    expect(formatPct(99.94, "en")).toBe("99.94%");
    expect(formatPct(100, "id")).toBe("100%");
    // Never claims 100% while there was downtime: two decimals, rounded down.
    expect(formatPct(99.999, "en")).toBe("99.99%");
    expect(formatPct(99.946, "id")).toBe("99,94%");
    expect(formatPct(null, "en")).toBe("—");
    expect(formatMonth("2026-10", "id")).toBe("Oktober 2026");
    expect(formatMonth("2026-10", "en")).toBe("October 2026");
    expect(formatDay("2026-10-23", "id")).toBe("23 Okt 2026");
    expect(formatDay("2026-10-23", "en")).toBe("23 Oct 2026");
  });

  it("describes an incident in plain words, without codes or addresses", () => {
    const down = { kind: "down" as const, minutes: 22, endedBy: "resolved" as const, site: "Toko utama", at: new Date("2026-10-22T19:14:00Z") };
    expect(incidentSentence(down, "id", Z)).toBe("23 Okt 02.14 · Toko utama · tidak bisa dibuka selama 22 menit · kembali normal");
    expect(incidentSentence(down, "en", Z)).toBe("23 Oct 02:14 · Toko utama · could not be opened for 22 minutes · back to normal");
    expect(incidentSentence({ ...down, endedBy: "open" }, "id", Z)).toMatch(/masih berlangsung$/);
    expect(incidentSentence({ ...down, endedBy: "open" }, "en", Z)).toMatch(/still ongoing$/);
    expect(incidentSentence({ ...down, kind: "slow", minutes: 4 }, "en", Z)).toContain("slow for 4 minutes");
    expect(incidentSentence({ ...down, kind: "slow", minutes: 1 }, "id", Z)).toContain("lambat selama 1 menit");
  });

  it("has the same labels in both languages, and none of them carry a link or a status code", () => {
    const id = reportText("id");
    const en = reportText("en");
    expect(Object.keys(id).sort()).toEqual(Object.keys(en).sort());
    expect(id.defaultTitle).toBe("Laporan pemantauan website");
    expect(en.defaultTitle).toBe("Website monitoring report");
    for (const v of [...Object.values(id), ...Object.values(en)]) expect(String(v)).not.toMatch(/https?:|\b[1-5]\d\d\b/);
  });

  it("writes the email in the report's language, with the owner's opening when there is one", () => {
    const id = emailBody("id", { clientName: "PT Kopi Sejahtera", month: "2026-10", opening: null, brand: "Studio Nusa", title: null });
    expect(id.subject).toBe("Laporan pemantauan website · Oktober 2026 · PT Kopi Sejahtera");
    expect(id.text).toContain("Laporan bulan Oktober 2026 terlampir");
    expect(id.text).toContain("Studio Nusa");
    const en = emailBody("en", { clientName: "PT Kopi Sejahtera", month: "2026-10", opening: "Hi Budi,", brand: "Studio Nusa", title: "Monthly shop report" });
    expect(en.subject).toBe("Monthly shop report · October 2026 · PT Kopi Sejahtera");
    expect(en.text.startsWith("Hi Budi,")).toBe(true);
    expect(en.html).toContain("Hi Budi,");
    expect(emailBody("en", { clientName: "<b>x</b>", month: "2026-10", opening: "<script>", brand: "B", title: null }).html).not.toMatch(/<script>|<b>x/);
  });
});
