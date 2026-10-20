import { describe, expect, it } from "vitest";
import type { RuleConfig } from "./catalog";
import { evaluate } from "./evaluate";
import type { DepFact, Facts } from "./facts";
import { openSeverity, planAlerts } from "./lifecycle";

const now = new Date("2026-10-16T03:00:00Z");
const APP = "22222222-2222-4222-8222-222222222222";
const rule: RuleConfig = { key: "VulnerableDependency", severity: "warning", threshold: null, enabled: true, channels: ["telegram"] };
const v = (o: Partial<DepFact["vulns"][number]> = {}): DepFact["vulns"][number] => ({ package: "next", installedVersion: "15.0.0", fixedVersion: "15.2.3", severity: "high", summary: "", dev: false, ...o });
const facts = (deps: DepFact[] | null): Facts => ({
  now, lastMinuteRunAt: now, monitors: [], apps: [{ id: APP, name: "acme-shop", latestProduction: null }], accounts: [], dbs: null, domains: null, dns: null, links: [], deps,
});
const ctx = { now, collectorStale: false, mutedApps: new Map<string, string>(), incidents: new Map<string, string>(), maintenance: new Set<string>() };

describe("VulnerableDependency", () => {
  it("isn't evaluated before any scan", () => {
    expect(evaluate(facts(null), [rule]).evaluated.has("VulnerableDependency")).toBe(false);
  });

  it("one alert per app: warning for high, critical (asked) for critical or RCE; ok below; unknown after a failed scan", () => {
    const one = (deps: DepFact["vulns"], error: string | null = null) => evaluate(facts([{ appId: APP, error, vulns: deps }]), [rule]).observations;
    expect(one([v(), v({ package: "lodash", installedVersion: "4.17.20", fixedVersion: "4.17.21" })])).toEqual([expect.objectContaining({
      rule: "VulnerableDependency", subject: APP, resourceId: APP, title: "acme-shop", status: "firing",
      message: "2 vulnerable packages (2 high): lodash 4.17.20 → 4.17.21, next 15.0.0 → 15.2.3.",
    })]);
    expect(one([v()])[0].severity).toBeUndefined();
    expect(one([v({ severity: "critical" })])[0]).toMatchObject({ status: "firing", severity: "critical" });
    expect(one([v({ severity: "moderate", summary: "Remote code execution via x" })])[0]).toMatchObject({ status: "firing", severity: "critical" });
    expect(one([v({ severity: "moderate" }), v({ severity: "critical", dev: true })])[0].status).toBe("ok");
    expect(one([v()], "OSV.dev answered HTTP 503")[0].status).toBe("unknown");
  });

  it("an app that isn't watched gets no observation", () => {
    expect(evaluate(facts([{ appId: "33333333-3333-4333-8333-333333333333", error: null, vulns: [v()] }]), [rule]).observations).toEqual([]);
  });

  it("critical raises only the default warning; the owner's own severity is kept", () => {
    expect(openSeverity("warning", "critical")).toBe("critical");
    expect(openSeverity("info", "critical")).toBe("info");
    expect(openSeverity("warning", undefined)).toBe("warning");
    const { observations, evaluated } = evaluate(facts([{ appId: APP, error: null, vulns: [v({ severity: "critical" })] }]), [rule]);
    expect(planAlerts([], observations, evaluated, [rule], ctx).open).toEqual([expect.objectContaining({ ruleKey: "VulnerableDependency", severity: "critical", pending: "open" })]);
    expect(planAlerts([], observations, evaluated, [{ ...rule, severity: "info" }], ctx).open[0].severity).toBe("info");
  });
});
