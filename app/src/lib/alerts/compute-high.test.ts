import { describe, expect, it } from "vitest";
import type { MetricsLatest } from "@/lib/databases/compute-metrics";
import { parseRuleForm, RULES, type RuleConfig } from "./catalog";
import { evaluate } from "./evaluate";
import type { Facts } from "./facts";

// Stage 12: ComputeHigh over the compute facts (Supabase projects with a metrics key).
const now = new Date("2026-10-16T12:00:00Z");
const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();
const latest = (o: Partial<MetricsLatest> = {}): MetricsLatest => ({ at: at(2), cpuPct: 10, memPct: 40, diskPct: 20, connUsed: 10, connMax: 60, prev: null, recent: [], ...o });
const facts = (compute: Facts["compute"]): Facts => ({ now, lastMinuteRunAt: now, monitors: [], apps: [], accounts: [], dbs: null, domains: null, dns: null, links: [], compute });
const rule = (threshold = 80): RuleConfig => ({ key: "ComputeHigh", severity: "warning", threshold, enabled: true, channels: ["telegram"] });

describe("ComputeHigh", () => {
  it("is a warning with one editable threshold (50–95), RAM 10 points above it", () => {
    expect(RULES.ComputeHigh).toMatchObject({ severity: "warning", threshold: 80, bounds: [50, 95], needs: "databases" });
    expect(RULES.ComputeHigh.condition(80)).toBe("Supabase CPU > 80% for 15 min, RAM > 90%, disk > 80% or connections > 80% of max");
    expect(parseRuleForm("ComputeHigh", { severity: "critical", threshold: "70", channels: ["telegram"], enabled: true })).toMatchObject({ ok: true, value: { threshold: 70 } });
    expect(parseRuleForm("ComputeHigh", { severity: "warning", threshold: "99", channels: [], enabled: true })).toMatchObject({ ok: false });
  });

  it("isn't evaluated without compute facts (no project has a key)", () => {
    expect(evaluate(facts(null), [rule()]).evaluated.has("ComputeHigh")).toBe(false);
    expect(evaluate(facts(undefined), [rule()]).evaluated.has("ComputeHigh")).toBe(false);
  });

  it("fires per project on a breach, ok under the limits, unknown without a fresh scrape", () => {
    const { observations, evaluated } = evaluate(facts([
      { id: "p1", name: "quillpad", latest: latest({ memPct: 93, diskPct: 85 }) },
      { id: "p2", name: "ticketer", latest: latest() },
      { id: "p3", name: "old", latest: latest({ at: at(30) }) },
      { id: "p4", name: "new", latest: null },
    ]), [rule()]);
    expect(evaluated.has("ComputeHigh")).toBe(true);
    expect(observations.map((o) => [o.subject, o.status])).toEqual([["p1", "firing"], ["p2", "ok"], ["p3", "unknown"], ["p4", "unknown"]]);
    expect(observations[0]).toMatchObject({ resourceId: "p1", provider: "supabase", title: "quillpad", message: "quillpad: RAM 93% (limit 90%), disk 85% (limit 80%)." });
  });

  it("uses the owner's threshold, and CPU only when sustained", () => {
    const recent = [15, 10, 5, 0].map((m) => ({ at: at(m), cpu: 75 }));
    const f = facts([{ id: "p1", name: "quillpad", latest: latest({ recent }) }]);
    expect(evaluate(f, [rule(80)]).observations[0].status).toBe("ok");
    expect(evaluate(f, [rule(70)]).observations[0]).toMatchObject({ status: "firing", message: "quillpad: CPU 75%+ for 15 min (limit 70%)." });
  });
});
