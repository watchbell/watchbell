import { describe, expect, it } from "vitest";
import { alertSection } from "@/lib/sections";
import { RULE_KEYS, RULES, type RuleConfig, ruleName } from "./catalog";
import { evaluate } from "./evaluate";
import type { Facts } from "./facts";
import { translateAlertText } from "./translate-id";

// Watchbell 1.7 (spec §6): a monthly report that couldn't be emailed after three tries tells the owner.
const now = new Date("2026-11-03T21:00:00Z");
const rules: RuleConfig[] = RULE_KEYS.map((key) => ({ key, severity: RULES[key].severity, threshold: RULES[key].threshold, enabled: true, channels: ["telegram"] }));
const base: Facts = { now, lastMinuteRunAt: new Date(now.getTime() - 60_000), monitors: [], apps: [], accounts: [], dbs: null, domains: null, dns: null, links: [] };
const find = (f: Facts, subject: string) => evaluate(f, rules).observations.find((o) => o.rule === "ReportSendFailed" && o.subject === subject);

describe("ReportSendFailed (1.7)", () => {
  it("is a warning rule of its own, always evaluated, named in plain words", () => {
    expect(RULES.ReportSendFailed).toMatchObject({ severity: "warning", threshold: null, source: "own" });
    expect(ruleName("ReportSendFailed")).toBe("Client report not sent");
    expect(alertSection("ReportSendFailed")).toBeNull();
  });

  it("fires for a month that failed, resolves when it was sent, and says nothing without reports", () => {
    const f = (status: "sent" | "failed" | "claimed") => ({ ...base, reportSends: [{ reportId: "r1", clientName: "PT Kopi Sejahtera", month: "2026-10", status, lastError: "The mail server took too long to answer." }] });
    expect(find(f("failed"), "r1")).toMatchObject({
      status: "firing", title: "PT Kopi Sejahtera",
      message: "The October 2026 report for PT Kopi Sejahtera couldn't be emailed after 3 tries: The mail server took too long to answer.",
    });
    expect(find(f("sent"), "r1")).toMatchObject({ status: "ok", message: "The October 2026 report for PT Kopi Sejahtera was emailed." });
    expect(find(f("claimed"), "r1")?.status).toBe("unknown"); // in flight: nothing new
    expect(evaluate({ ...base, reportSends: null }, rules).observations.some((o) => o.rule === "ReportSendFailed")).toBe(false);
    // Review I-4: loaded but empty (the last failing report deleted, or its auto-send turned off) is still evaluated,
    // so an open alert resolves instead of ringing for ever.
    expect(evaluate({ ...base, reportSends: [] }, rules).evaluated.has("ReportSendFailed")).toBe(true);
  });

  it("reads in Indonesian too, and never carries an address", () => {
    expect(translateAlertText("ReportSendFailed", "The October 2026 report for PT Kopi Sejahtera couldn't be emailed after 3 tries: The mail server took too long to answer."))
      .toBe("Laporan Oktober 2026 untuk PT Kopi Sejahtera gagal dikirim setelah 3 kali coba; alasannya ada di Manage › Reports.");
    expect(translateAlertText("ReportSendFailed", "The October 2026 report for PT Kopi Sejahtera was emailed.")).toBe("Laporan Oktober 2026 untuk PT Kopi Sejahtera sudah terkirim.");
  });
});
