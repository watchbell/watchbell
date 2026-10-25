import { describe, expect, it } from "vitest";
import type { Finding } from "@/lib/security/types";
import { RULES, type RuleConfig } from "./catalog";
import { evaluate } from "./evaluate";
import type { Facts, FrameworkFact } from "./facts";
import { planAlerts } from "./lifecycle";

const now = new Date("2026-10-23T03:00:00Z");
const APP = "22222222-2222-4222-8222-222222222222";
const rule: RuleConfig = { key: "FrameworkVulnerable", severity: "warning", threshold: null, enabled: true, channels: ["telegram", "email_digest"] };
const finding = (o: Partial<Finding> = {}): Finding => ({ id: "GHSA-aaaa-bbbb-cccc", cve: "CVE-2026-1111", summary: "Cache poisoning", severity: "HIGH", fixed: "16.4.1", ...o });
const facts = (frameworks: FrameworkFact[] | null): Facts => ({
  now, lastMinuteRunAt: now, monitors: [], apps: [{ id: APP, name: "shopfront", latestProduction: null }], accounts: [], dbs: null, domains: null, dns: null, links: [], frameworks,
});
const ctx = { now, collectorStale: false, mutedApps: new Map<string, string>(), incidents: new Map<string, string>(), maintenance: new Set<string>() };
const one = (s: Omit<FrameworkFact, "appId">) => evaluate(facts([{ appId: APP, ...s }]), [rule]).observations;

describe("FrameworkVulnerable", () => {
  it("is in the catalog: warning by default, own source, no data needs, the brief's condition", () => {
    expect(RULES.FrameworkVulnerable).toMatchObject({ severity: "warning", threshold: null, bounds: null, source: "own", needs: null, sampled: false });
    expect(RULES.FrameworkVulnerable.condition(null)).toBe("The app's Next.js version has a known advisory (OSV.dev)");
  });

  it("isn't evaluated before any Next.js check", () => {
    expect(evaluate(facts(null), [rule]).evaluated.has("FrameworkVulnerable")).toBe(false);
  });

  it("fires on a vulnerable app with its version, findings and the highest fixed version; critical when one advisory is", () => {
    const high = one({ version: "16.3.8", status: "vulnerable", findings: [finding(), finding({ id: "GHSA-dddd-eeee-ffff", fixed: "16.3.9", severity: "MODERATE" })] });
    expect(high).toEqual([expect.objectContaining({
      rule: "FrameworkVulnerable", subject: APP, resourceId: APP, title: "shopfront", status: "firing",
      message: "Next.js 16.3.8 has 2 known vulnerabilities (high), fixed in 16.4.1.",
    })]);
    expect(high[0].severity).toBeUndefined();
    const crit = one({ version: "16.3.8", status: "vulnerable", findings: [finding({ severity: "CRITICAL" })] });
    expect(crit[0]).toMatchObject({ status: "firing", severity: "critical", message: "Next.js 16.3.8 has 1 known vulnerability (critical), fixed in 16.4.1." });
    expect(one({ version: "15.0.0", status: "vulnerable", findings: [finding({ fixed: null })] })[0].message).toBe("Next.js 15.0.0 has 1 known vulnerability (high), no fix yet.");
  });

  it("doesn't fire when the check is ok (resolves), and says nothing on unknown or error", () => {
    expect(one({ version: "16.4.1", status: "ok", findings: [] })).toEqual([expect.objectContaining({ status: "ok", message: "shopfront runs Next.js 16.4.1 with no known advisories." })]);
    expect(one({ version: null, status: "unknown", findings: [] })[0].status).toBe("unknown");
    expect(one({ version: "16.3.8", status: "error", findings: [finding()] })[0].status).toBe("unknown");
    expect(one({ version: "16.3.8", status: "vulnerable", findings: [] })[0].status).toBe("unknown");
  });

  it("an app that isn't watched gets no observation", () => {
    expect(evaluate(facts([{ appId: "33333333-3333-4333-8333-333333333333", version: "16.3.8", status: "vulnerable", findings: [finding()] }]), [rule]).observations).toEqual([]);
  });

  it("opens a critical alert for a critical advisory (default warning raised), the owner's own severity kept", () => {
    const { observations, evaluated } = evaluate(facts([{ appId: APP, version: "16.3.8", status: "vulnerable", findings: [finding({ severity: "CRITICAL" })] }]), [rule]);
    expect(planAlerts([], observations, evaluated, [rule], ctx).open).toEqual([expect.objectContaining({ ruleKey: "FrameworkVulnerable", severity: "critical", pending: "open" })]);
    expect(planAlerts([], observations, evaluated, [{ ...rule, severity: "info" }], ctx).open[0].severity).toBe("info");
  });
});
