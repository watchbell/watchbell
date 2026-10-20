import { beforeEach, describe, expect, it, vi } from "vitest";
import { alertRules, alerts, maintenanceWindows, providerStatus } from "@/db/schema";
import type { Facts } from "@/lib/alerts/facts";
import { type Call, fakeDb, limitOf, payloadOf } from "./fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown }, facts: null as unknown }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("./alert-facts-db", () => ({ loadFacts: async () => h.facts }));

import { evaluateAlerts, listFiring, listResolved, openAlertCount, rulesWithState, saveRule, silenceAlert } from "./alerts-db";

const now = new Date("2026-10-13T12:00:00Z");
const facts = (o: Partial<Facts> = {}): Facts => ({
  now, lastMinuteRunAt: new Date(now.getTime() - 60_000), monitors: [], apps: [], accounts: [], dbs: null, domains: null, dns: null, links: [], ...o,
});
const down = { id: "m1", appId: "a1", appName: "web", url: "https://web.example.com/", kind: "http" as const, state: "err" as const, failStreak: 3, lastStatus: 502, lastCheckedAt: now, p95Last10: 300, checksLast10: 10 };
const rule = (key: string, over: Record<string, unknown> = {}) => ({ key, severity: "critical", threshold: 3, enabled: true, channels: ["telegram"], ...over });

const use = (reads: unknown[][]) => {
  const f = fakeDb(reads);
  h.current = f;
  return f;
};
// evaluateAlerts' reads run side by side, so each answers by its table: rules, open alerts, provider feeds, maintenance
// windows (the facts are mocked).
const useEval = ([rules, open, feeds, windows = []]: unknown[][]) => {
  const by = new Map<unknown, unknown[]>([[alertRules, rules], [alerts, open], [providerStatus, feeds], [maintenanceWindows, windows]]);
  const f = fakeDb(Array.from({ length: 4 }, () => (calls: Call[]) => by.get(calls.find((c) => c.method === "from")?.args[0]) ?? []));
  h.current = f;
  return f;
};

beforeEach(() => { h.current = null; h.facts = null; });

describe("evaluateAlerts", () => {
  it("opens an alert with an open notice for a monitor that failed 3 times", async () => {
    h.facts = facts({ monitors: [down] });
    const f = useEval([[rule("MonitorDown")], [], []]);
    expect(await evaluateAlerts(now)).toEqual({ opened: 1, resolved: 0 });
    const ins = f.writes.filter((w) => w.kind === "insert" && w.table === alerts);
    expect(ins).toHaveLength(1);
    expect(payloadOf(ins[0].calls)).toMatchObject({ ruleKey: "MonitorDown", subject: "m1", resourceId: "a1", severity: "critical", pending: "open", pendingSince: now });
    expect(ins[0].calls.some((c) => c.method === "onConflictDoNothing")).toBe(true);
  });

  it("writes nothing when nothing changed", async () => {
    h.facts = facts({ monitors: [] });
    const f = useEval([[rule("MonitorDown")], [], []]);
    expect(await evaluateAlerts(now)).toEqual({ opened: 0, resolved: 0 });
    expect(f.writes).toEqual([]);
  });

  it("never resolves from a rule it didn't evaluate (S1), e.g. one whose stage isn't merged", async () => {
    h.facts = facts();
    const open = { id: "x1", ruleKey: "DatabasePaused", subject: "s1", okStreak: 0, lastSampleAt: null, silencedUntil: null, silencedUntilResolved: false, notifiedOpen: true, lastNotifiedAt: now, pending: null };
    const f = useEval([[rule("DatabasePaused", { threshold: null, severity: "warning" })], [open], []]);
    expect(await evaluateAlerts(now)).toEqual({ opened: 0, resolved: 0 });
    expect(f.writes).toEqual([]);
  });

  it("opens CollectorStale alone in a watchdog pass and mutes nothing else", async () => {
    h.facts = facts({ lastMinuteRunAt: new Date(now.getTime() - 9 * 60_000), monitors: [down] });
    const f = useEval([[rule("CollectorStale", { threshold: 5 }), rule("MonitorDown")], [], []]);
    expect(await evaluateAlerts(now, { only: ["CollectorStale"] })).toEqual({ opened: 1, resolved: 0 });
    expect(payloadOf(f.writes.find((w) => w.table === alerts)!.calls)).toMatchObject({ ruleKey: "CollectorStale", pending: "open", causedBy: null });
  });

  // I2: CollectorStale judges the primary scheduler, but other alerts are muted only when NO scheduler has collected lately.
  it("keeps alerts working while the QStash fallback collects (primary stale, a recent run of any trigger)", async () => {
    h.facts = facts({ lastMinuteRunAt: new Date(now.getTime() - 9 * 60_000), lastAnyRunAt: new Date(now.getTime() - 3 * 60_000), monitors: [down] });
    const f = useEval([[rule("CollectorStale", { threshold: 5 }), rule("MonitorDown")], [], []]);
    expect(await evaluateAlerts(now)).toEqual({ opened: 2, resolved: 0 });
    const opened = f.writes.filter((w) => w.table === alerts && w.kind === "insert").map((w) => payloadOf(w.calls));
    expect(opened.find((o) => o?.ruleKey === "CollectorStale")).toMatchObject({ pending: "open", causedBy: null });
    expect(opened.find((o) => o?.ruleKey === "MonitorDown")).toMatchObject({ pending: "open", causedBy: null });
  });

  it("mutes the other alerts when no scheduler has collected recently", async () => {
    h.facts = facts({ lastMinuteRunAt: new Date(now.getTime() - 9 * 60_000), lastAnyRunAt: new Date(now.getTime() - 8 * 60_000), monitors: [down] });
    const f = useEval([[rule("CollectorStale", { threshold: 5 }), rule("MonitorDown")], [], []]);
    await evaluateAlerts(now);
    const opened = f.writes.filter((w) => w.table === alerts && w.kind === "insert").map((w) => payloadOf(w.calls));
    expect(opened.find((o) => o?.ruleKey === "MonitorDown")).toMatchObject({ pending: null, causedBy: "CollectorStale" });
    expect(opened.find((o) => o?.ruleKey === "CollectorStale")).toMatchObject({ pending: "open" });
  });

  it("mutes when the collector has never run", async () => {
    h.facts = facts({ lastMinuteRunAt: null, lastAnyRunAt: null, monitors: [down] });
    const f = useEval([[rule("CollectorStale", { threshold: 5 }), rule("MonitorDown")], [], []]);
    await evaluateAlerts(now);
    const opened = f.writes.filter((w) => w.table === alerts && w.kind === "insert").map((w) => payloadOf(w.calls));
    expect(opened.find((o) => o?.ruleKey === "MonitorDown")).toMatchObject({ pending: null, causedBy: "CollectorStale" });
  });

  it("labels alerts with a provider incident from the status feeds", async () => {
    h.facts = facts({ monitors: [down] });
    const f = useEval([[rule("MonitorDown")], [], [{ provider: "vercel", state: "warn" }]]);
    await evaluateAlerts(now);
    expect(payloadOf(f.writes.find((w) => w.table === alerts)!.calls)).toMatchObject({ providerIncident: "Vercel" });
  });
});

describe("evaluateAlerts inside a maintenance window (U5 / B3)", () => {
  const win = (o: Record<string, unknown> = {}) => ({ id: "w1", scope: "app", resourceId: "a1", monitorId: null, startsAt: new Date(now.getTime() - 10 * 60_000), durationMin: 60, weekly: false, note: null, ...o });
  it("opens nothing for a monitor of an app inside a window", async () => {
    h.facts = facts({ monitors: [down] });
    const f = useEval([[rule("MonitorDown")], [], [], [win()]]);
    expect(await evaluateAlerts(now)).toEqual({ opened: 0, resolved: 0 });
    expect(f.writes).toEqual([]);
  });
  it("opens at once when the window is over and the monitor is still down", async () => {
    h.facts = facts({ monitors: [down] });
    useEval([[rule("MonitorDown")], [], [], [win({ startsAt: new Date(now.getTime() - 61 * 60_000) })]]);
    expect(await evaluateAlerts(now)).toEqual({ opened: 1, resolved: 0 });
  });
  it("a whole-app window holds back that app's DeploymentFailed even when the app has no active monitor (review M2)", async () => {
    const failed = { id: "a1", name: "web", latestProduction: { state: "error", sha: "0d3c8aa1", createdAt: now } };
    h.facts = facts({ apps: [failed, { ...failed, id: "a2", name: "api" }] });
    const f = useEval([[rule("DeploymentFailed")], [], [], [win()]]);
    expect(await evaluateAlerts(now)).toEqual({ opened: 1, resolved: 0 });
    expect(payloadOf(f.writes.find((w) => w.table === alerts)!.calls)).toMatchObject({ ruleKey: "DeploymentFailed", subject: "a2" });
  });
  it("an all-monitors window holds back every app's DeploymentFailed", async () => {
    const failed = { id: "a1", name: "web", latestProduction: { state: "error", sha: "0d3c8aa1", createdAt: now } };
    h.facts = facts({ apps: [failed, { ...failed, id: "a2", name: "api" }] });
    useEval([[rule("DeploymentFailed")], [], [], [win({ scope: "all", resourceId: null })]]);
    expect(await evaluateAlerts(now)).toEqual({ opened: 0, resolved: 0 });
  });
  it("a window on one monitor leaves the app's other monitors alerting", async () => {
    h.facts = facts({ monitors: [down, { ...down, id: "m2" }] });
    const f = useEval([[rule("MonitorDown")], [], [], [win({ scope: "monitor", resourceId: null, monitorId: "m1" })]]);
    expect(await evaluateAlerts(now)).toEqual({ opened: 1, resolved: 0 });
    expect(payloadOf(f.writes.find((w) => w.table === alerts)!.calls)).toMatchObject({ subject: "m2" });
  });

  // U3 + U5: a heartbeat is a monitor fact like any other (id + app id), so the same set holds it back.
  const hbDown = { ...down, id: "hb1", url: "backup job", kind: "heartbeat" as const, lastStatus: null, failStreak: 3, p95Last10: null, checksLast10: 0 };
  it("opens nothing for a heartbeat that goes down inside its app's window, or inside a window on the heartbeat itself", async () => {
    h.facts = facts({ monitors: [hbDown] });
    const f = useEval([[rule("MonitorDown")], [], [], [win()]]);
    expect(await evaluateAlerts(now)).toEqual({ opened: 0, resolved: 0 });
    expect(f.writes).toEqual([]);
    h.facts = facts({ monitors: [hbDown] });
    useEval([[rule("MonitorDown")], [], [], [win({ scope: "monitor", resourceId: null, monitorId: "hb1" })]]);
    expect(await evaluateAlerts(now)).toEqual({ opened: 0, resolved: 0 });
  });
  it("opens the heartbeat's alert once the window is over and it is still down", async () => {
    h.facts = facts({ monitors: [hbDown] });
    const f = useEval([[rule("MonitorDown")], [], [], [win({ startsAt: new Date(now.getTime() - 61 * 60_000) })]]);
    expect(await evaluateAlerts(now)).toEqual({ opened: 1, resolved: 0 });
    expect(payloadOf(f.writes.find((w) => w.table === alerts)!.calls)).toMatchObject({ ruleKey: "MonitorDown", subject: "hb1", title: "web backup job" });
  });
});

describe("openAlertCount", () => {
  it("counts the open critical and warning alerts", async () => {
    use([[{ n: 3 }]]);
    expect(await openAlertCount()).toBe(3);
    use([[]]);
    expect(await openAlertCount()).toBe(0);
  });
});

describe("alert page reads", () => {
  it("lists open alerts with their resource, at most 200", async () => {
    const f = use([[{ a: { id: "x1", ruleKey: "MonitorDown", resolvedAt: null }, name: "web", kind: "app" }, { a: { id: "x2", ruleKey: "CredentialExpiring" }, name: null, kind: null }]]);
    const rows = await listFiring();
    expect(limitOf(f.queries[0])).toBe(200);
    expect(rows).toEqual([expect.objectContaining({ id: "x1", resourceName: "web", resourceKind: "app" }), expect.objectContaining({ id: "x2", resourceName: null, resourceKind: null })]);
  });

  it("lists what resolved in the last 7 days, at most 50", async () => {
    const at = new Date("2026-10-13T11:00:00Z");
    const f = use([[{ id: "x1", ruleKey: "MonitorDown", severity: "critical", title: "web /", startedAt: at, resolvedAt: at }]]);
    expect(await listResolved(now)).toHaveLength(1);
    expect(limitOf(f.queries[0])).toBe(50);
  });

  it("says a rule has no data until its stage delivers a snapshot (S1)", async () => {
    const all = ["MonitorDown", "DatabasePaused", "CertExpiringSoon", "DnsProxiedToVercel"].map((k) => rule(k));
    use([all, [{ key: "MonitorDown", n: 2 }], [{ kind: "supabase_project" }]]);
    const rows = await rulesWithState();
    const by = (k: string) => rows.find((r) => r.rule.key === k);
    expect(by("MonitorDown")).toMatchObject({ firing: 2, hasData: true });
    expect(by("DatabasePaused")).toMatchObject({ firing: 0, hasData: true });
    expect(by("CertExpiringSoon")?.hasData).toBe(false);
    expect(by("DnsProxiedToVercel")?.hasData).toBe(false);
  });
});

describe("silenceAlert and saveRule", () => {
  it("silences for an hour or until resolved, only while the alert is open", async () => {
    const row = { ruleKey: "MonitorDown", title: "web /", resourceId: "a1" };
    const f = fakeDb([], [[row], [row]]);
    h.current = f;
    expect(await silenceAlert("x1", "1h", "u1", now)).toEqual(row);
    expect(payloadOf(f.writes[0].calls)).toEqual({ silencedUntil: new Date(now.getTime() + 3_600_000), silencedUntilResolved: false, silencedBy: "u1" });
    expect(await silenceAlert("x1", "resolved", "u1", now)).toEqual(row);
    expect(payloadOf(f.writes[1].calls)).toEqual({ silencedUntil: null, silencedUntilResolved: true, silencedBy: "u1" });
    expect(f.writes.every((w) => w.calls.some((c) => c.method === "where"))).toBe(true);
  });

  it("unsilences, and answers false for an alert that is already resolved", async () => {
    const f = fakeDb([], [[{ ruleKey: "MonitorDown", title: "web /", resourceId: "a1" }], []]);
    h.current = f;
    expect(await silenceAlert("x1", "off", "u1", now)).toMatchObject({ ruleKey: "MonitorDown" });
    expect(payloadOf(f.writes[0].calls)).toEqual({ silencedUntil: null, silencedUntilResolved: false, silencedBy: null });
    expect(await silenceAlert("x2", "1h", "u1", now)).toBeNull();
  });

  it("saves a rule's severity, threshold, channels and switch, and says false when the rule row is missing (M5)", async () => {
    const f = fakeDb([], [[{ key: "HighLatency" }], []]);
    h.current = f;
    expect(await saveRule("HighLatency", { severity: "critical", threshold: 2000, channels: ["telegram"], enabled: false })).toBe(true);
    expect(await saveRule("HighLatency", { severity: "critical", threshold: 2000, channels: ["telegram"], enabled: false })).toBe(false);
    expect(f.writes[0].table).toBe(alertRules);
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ severity: "critical", threshold: 2000, channels: ["telegram"], enabled: false });
  });
});
