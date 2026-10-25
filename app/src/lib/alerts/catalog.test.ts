import { describe, expect, it } from "vitest";
import { parseRuleForm, RULE_KEYS, RULES } from "./catalog";

describe("RULES", () => {
  it("has the 13 rules of spec §10 (+ Stage 12 ComputeHigh, Stage 9 slice 5 VulnerableDependency, Stage 8 DbQuotaHigh) with the mockup's conditions", () => {
    expect(RULE_KEYS).toHaveLength(18); // + Watchbell 1.2 FrameworkVulnerable, 1.2.1 MonitorDomainMoved
    expect(RULES.DbQuotaHigh).toMatchObject({ severity: "warning", threshold: 80, bounds: [10, 100], needs: "databases" });
    expect(RULES.DbQuotaHigh.condition(80)).toBe("Turso, Upstash or D1 usage > 80% of a free-plan quota");
    expect(RULES.VulnerableDependency).toMatchObject({ severity: "warning", threshold: null, bounds: null, needs: null, sampled: false });
    expect(RULES.MonitorDown.condition(3)).toBe("3 failed checks in a row");
    expect(RULES.HighLatency.condition(1500)).toBe("p95 > 1,500 ms for 10 min");
    expect(RULES.CollectorStale.condition(5)).toBe("No collector run for 5 min");
    expect(RULES.DeploymentFailed.condition(null)).toBe("Production deployment state = ERROR");
    expect(RULES.CredentialExpiring.condition(14)).toBe("Account credential expires in < 14 days");
  });
  it("marks the rules that need stage 3 or 4 data", () => {
    expect(RULES.DatabasePaused.needs).toBe("databases");
    expect(RULES.CertExpiringSoon.needs).toBe("domains");
    expect(RULES.DnsProxiedToVercel.needs).toBe("dns");
    expect(RULES.MonitorDown.needs).toBeNull();
  });
});

describe("parseRuleForm", () => {
  it("accepts a valid edit", () => {
    expect(parseRuleForm("HighLatency", { severity: "critical", threshold: "2,000", channels: ["telegram", "discord"], enabled: true }))
      .toEqual({ ok: true, value: { severity: "critical", threshold: 2000, channels: ["telegram", "discord"], enabled: true } });
  });
  it("rejects a threshold outside the rule's bounds, an unknown severity and unknown channels", () => {
    const r = parseRuleForm("MonitorDown", { severity: "loud", threshold: "0", channels: ["sms"], enabled: true });
    expect(r).toEqual({ ok: false, fieldErrors: { severity: "Pick a severity.", threshold: "Enter a whole number from 1 to 10.", channels: "Pick from Telegram, Discord and the daily digest." } });
  });
  it("ignores a threshold on a rule without one", () => {
    expect(parseRuleForm("DeploymentFailed", { severity: "warning", threshold: "9", channels: [], enabled: false }))
      .toEqual({ ok: true, value: { severity: "warning", threshold: null, channels: [], enabled: false } });
  });
});
