import { describe, expect, it } from "vitest";
import { RULE_KEYS, RULES, type RuleConfig } from "./catalog";
import type { Observation } from "./evaluate";
import { type OpenAlert, type PlanContext, planAlerts } from "./lifecycle";

const now = new Date("2026-10-13T12:00:00Z");
const min = (n: number) => new Date(now.getTime() - n * 60_000);
const rules: RuleConfig[] = RULE_KEYS.map((key) => ({ key, severity: RULES[key].severity, threshold: RULES[key].threshold, enabled: true, channels: ["telegram", "email_digest"] }));
const ctx = (o: Partial<PlanContext> = {}): PlanContext => ({ now, collectorStale: false, mutedApps: new Map(), incidents: new Map(), maintenance: new Set(), ...o });
const obs = (o: Partial<Observation> = {}): Observation => ({
  rule: "MonitorDown", subject: "m1", status: "firing", resourceId: "a1", accountId: null, title: "web /", message: "down", provider: "vercel", sampleAt: now, ...o,
});
const alert = (o: Partial<OpenAlert> = {}): OpenAlert => ({
  id: "x1", ruleKey: "MonitorDown", subject: "m1", okStreak: 0, lastSampleAt: min(1), silencedUntil: null, silencedUntilResolved: false,
  notifiedOpen: true, lastNotifiedAt: min(10), pending: null, ...o,
});
const ev = (keys: string[]) => new Set(keys) as Set<(typeof RULE_KEYS)[number]>;

describe("planAlerts", () => {
  it("opens a new alert with an open notice", () => {
    const p = planAlerts([], [obs()], ev(["MonitorDown"]), rules, ctx());
    expect(p.open).toEqual([expect.objectContaining({ ruleKey: "MonitorDown", subject: "m1", severity: "critical", pending: "open", causedBy: null, providerIncident: null })]);
  });

  it("opens without a notice when the rule only goes to the digest", () => {
    const digestOnly = rules.map((r) => (r.key === "MonitorDown" ? { ...r, channels: ["email_digest" as const] } : r));
    expect(planAlerts([], [obs()], ev(["MonitorDown"]), digestOnly, ctx()).open[0].pending).toBeNull();
  });

  it("mutes everything but CollectorStale while the collector is stale", () => {
    const p = planAlerts([], [obs(), obs({ rule: "CollectorStale", subject: "collector", resourceId: null })], ev(["MonitorDown", "CollectorStale"]), rules, ctx({ collectorStale: true }));
    expect(p.open.find((a) => a.ruleKey === "MonitorDown")).toMatchObject({ pending: null, causedBy: "CollectorStale" });
    expect(p.open.find((a) => a.ruleKey === "CollectorStale")?.pending).toBe("open");
  });

  it("mutes MonitorDown of an app whose database is paused, and labels provider incidents", () => {
    const p = planAlerts([], [obs()], ev(["MonitorDown"]), rules, ctx({ mutedApps: new Map([["a1", "DatabasePaused · quillpad"]]), incidents: new Map([["vercel", "Vercel"]]) }));
    expect(p.open[0]).toMatchObject({ pending: null, causedBy: "DatabasePaused · quillpad", providerIncident: "Vercel" });
  });

  it("doesn't open inside a maintenance window (5b hook)", () => {
    expect(planAlerts([], [obs()], ev(["MonitorDown"]), rules, ctx({ maintenance: new Set(["m1"]) })).open).toEqual([]);
  });

  // I1: an open that was never notified (muted at the start, or its notice was dropped) still pages once it can.
  it("sends the open notice once the mute that held it back has lifted", () => {
    const muted = alert({ notifiedOpen: false, lastNotifiedAt: null, pending: null, pendingSince: null });
    expect(planAlerts([muted], [obs()], ev(["MonitorDown"]), rules, ctx({ collectorStale: true })).touch[0].pending).toBeUndefined();
    const t = planAlerts([muted], [obs()], ev(["MonitorDown"]), rules, ctx()).touch[0];
    expect(t).toMatchObject({ id: "x1", pending: "open", causedBy: null });
  });

  it("keeps a muted open quiet while the database is still paused, and while it is silenced", () => {
    const muted = alert({ notifiedOpen: false, lastNotifiedAt: null });
    const paused = ctx({ mutedApps: new Map([["a1", "DatabasePaused · quillpad"]]) });
    expect(planAlerts([muted], [obs()], ev(["MonitorDown"]), rules, paused).touch[0]).toMatchObject({ causedBy: "DatabasePaused · quillpad" });
    expect(planAlerts([muted], [obs()], ev(["MonitorDown"]), rules, paused).touch[0].pending).toBeUndefined();
    const silenced = { ...muted, silencedUntilResolved: true };
    expect(planAlerts([silenced], [obs()], ev(["MonitorDown"]), rules, ctx()).touch[0].pending).toBeUndefined();
  });

  it("retries a dropped open notice, but not before 6 hours after the failed attempt", () => {
    const dropped = (hoursAgo: number) => alert({ notifiedOpen: false, lastNotifiedAt: null, pending: null, pendingSince: new Date(now.getTime() - hoursAgo * 3_600_000) });
    expect(planAlerts([dropped(1)], [obs()], ev(["MonitorDown"]), rules, ctx()).touch[0].pending).toBeUndefined();
    expect(planAlerts([dropped(6)], [obs()], ev(["MonitorDown"]), rules, ctx()).touch[0].pending).toBe("open");
  });

  it("doesn't queue a second open while one is already waiting, or for a digest-only rule", () => {
    const waiting = alert({ notifiedOpen: false, lastNotifiedAt: null, pending: "open", pendingSince: min(1) });
    expect(planAlerts([waiting], [obs()], ev(["MonitorDown"]), rules, ctx()).touch[0].pending).toBeUndefined();
    const digestOnly = rules.map((r) => (r.key === "MonitorDown" ? { ...r, channels: ["email_digest" as const] } : r));
    const quiet = alert({ notifiedOpen: false, lastNotifiedAt: null });
    expect(planAlerts([quiet], [obs()], ev(["MonitorDown"]), digestOnly, ctx()).touch[0].pending).toBeUndefined();
  });

  it("repeats every 6 hours unless silenced", () => {
    const old = alert({ lastNotifiedAt: new Date(now.getTime() - 6 * 3_600_000) });
    expect(planAlerts([old], [obs()], ev(["MonitorDown"]), rules, ctx()).touch[0]).toMatchObject({ id: "x1", pending: "repeat", okStreak: 0 });
    const silenced = { ...old, silencedUntil: new Date(now.getTime() + 60_000) };
    expect(planAlerts([silenced], [obs()], ev(["MonitorDown"]), rules, ctx()).touch[0].pending).toBeUndefined();
    const forever = { ...old, silencedUntilResolved: true };
    expect(planAlerts([forever], [obs()], ev(["MonitorDown"]), rules, ctx()).touch[0].pending).toBeUndefined();
  });

  it("resolves a sampled rule only after 2 passing evaluations with newer checks", () => {
    const a = alert({ okStreak: 0, lastSampleAt: min(1) });
    const one = planAlerts([a], [obs({ status: "ok" })], ev(["MonitorDown"]), rules, ctx());
    expect(one.resolve).toEqual([]);
    expect(one.touch[0]).toMatchObject({ okStreak: 1, lastSampleAt: now });
    const same = planAlerts([{ ...a, okStreak: 1, lastSampleAt: now }], [obs({ status: "ok" })], ev(["MonitorDown"]), rules, ctx());
    expect(same.resolve).toEqual([]); // no newer check: a forced run doesn't count twice
    const two = planAlerts([{ ...a, okStreak: 1, lastSampleAt: min(1) }], [obs({ status: "ok" })], ev(["MonitorDown"]), rules, ctx());
    expect(two.resolve).toEqual([{ id: "x1", pending: "resolve" }]);
  });

  it("resets the good streak when it fails again (a flap opens nothing new)", () => {
    const p = planAlerts([alert({ okStreak: 1 })], [obs()], ev(["MonitorDown"]), rules, ctx());
    expect(p.open).toEqual([]);
    expect(p.touch[0].okStreak).toBe(0);
  });

  it("resolves an unsampled rule at once, and drops a resolve whose open was never sent", () => {
    const a = alert({ id: "c", ruleKey: "CredentialExpiring", subject: "acc", notifiedOpen: false, pending: "open" });
    const p = planAlerts([a], [obs({ rule: "CredentialExpiring", subject: "acc", status: "ok", sampleAt: null })], ev(["CredentialExpiring"]), rules, ctx());
    expect(p.resolve).toEqual([{ id: "c", pending: null }]);
  });

  it("leaves an alert alone while its observation is unknown", () => {
    const p = planAlerts([alert()], [obs({ status: "unknown" })], ev(["MonitorDown"]), rules, ctx());
    expect(p).toEqual({ open: [], touch: [], resolve: [] });
  });

  it("resolves silently when the subject is gone or the rule is disabled", () => {
    expect(planAlerts([alert()], [], ev(["MonitorDown"]), rules, ctx()).resolve).toEqual([{ id: "x1", pending: null }]);
    const off = rules.map((r) => (r.key === "MonitorDown" ? { ...r, enabled: false } : r));
    expect(planAlerts([alert()], [], ev([]), off, ctx()).resolve).toEqual([{ id: "x1", pending: null }]);
  });

  it("keeps alerts of rules that weren't evaluated this time", () => {
    expect(planAlerts([alert()], [], ev(["CollectorStale"]), rules, ctx())).toEqual({ open: [], touch: [], resolve: [] });
  });
});
