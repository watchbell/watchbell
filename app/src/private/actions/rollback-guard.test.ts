import { describe, expect, it } from "vitest";
import { CHRONIC_GAP_MS, DOWN_NEAR_DEPLOY_MS, notTiedNote, type NextCheck, type NextEvent, previousNext, problemSince, UNKNOWN_NOTE, vulnerableNote } from "./rollback-guard";

const now = new Date("2026-10-24T05:00:00Z");
const h = (n: number) => new Date(now.getTime() - n * 3_600_000);
const curLive = h(1);
const prevLive = h(48);

describe("problemSince: when this problem started, counting the episodes just before it", () => {
  it("is the alert's own start with no history", () => {
    expect(problemSince(h(1), [])).toEqual(h(1));
  });
  it("chains back through episodes that resolved within the gap (a chronic, flapping alert)", () => {
    const history = [
      { startedAt: h(30), resolvedAt: h(20) }, // 20 h before the next start: linked
      { startedAt: h(10), resolvedAt: h(5) }, // 4 h before the current start: linked
      { startedAt: h(200), resolvedAt: h(190) }, // far older than the gap from h(30): not linked
    ];
    expect(problemSince(h(1), history)).toEqual(h(30));
  });
  it("leaves out an older episode that resolved more than the gap before", () => {
    expect(problemSince(h(1), [{ startedAt: h(40), resolvedAt: new Date(h(1).getTime() - CHRONIC_GAP_MS - 1) }])).toEqual(h(1));
  });
  // Fix round 1 (review I2): an earlier, unrelated outage never hides a new bad deploy.
  it("MonitorDown: only an episode still open when the deploy went live, or resolved at most 15 min before it", () => {
    const liveAt = h(4);
    const o = { ruleKey: "MonitorDown", liveAt };
    // Resolved hours before the deploy (an earlier bad deploy, rolled back): not linked.
    expect(problemSince(h(3.9), [{ startedAt: h(9), resolvedAt: h(8.8) }], o)).toEqual(h(3.9));
    // Still down when the deploy went live, or back only minutes before it: the same outage.
    expect(problemSince(h(3.9), [{ startedAt: h(9), resolvedAt: h(3.95) }], o)).toEqual(h(9));
    expect(problemSince(h(3.9), [{ startedAt: h(9), resolvedAt: new Date(liveAt.getTime() - DOWN_NEAR_DEPLOY_MS) }], o)).toEqual(h(9));
    expect(problemSince(h(3.9), [{ startedAt: h(9), resolvedAt: new Date(liveAt.getTime() - DOWN_NEAR_DEPLOY_MS - 1) }], o)).toEqual(h(3.9));
    // An episode after the deploy chains (the deploy is still the one that started it); no deploy time: no chain.
    expect(problemSince(h(1), [{ startedAt: h(3.8), resolvedAt: h(3.5) }], o)).toEqual(h(3.8));
    expect(problemSince(h(1), [{ startedAt: h(3.8), resolvedAt: h(3.5) }], { ruleKey: "MonitorDown", liveAt: null })).toEqual(h(1));
    // HighLatency keeps the 24 h chain.
    expect(problemSince(h(3.9), [{ startedAt: h(9), resolvedAt: h(8.8) }], { ruleKey: "HighLatency", liveAt })).toEqual(h(9));
  });
  it("ignores the alert itself and later rows", () => {
    expect(problemSince(h(1), [{ startedAt: h(1), resolvedAt: null }, { startedAt: h(0.5), resolvedAt: h(0.2) }])).toEqual(h(1));
  });
});

describe("previousNext: the previous production deployment's Next.js status", () => {
  const check = (o: Partial<NextCheck> = {}): NextCheck => ({ version: "16.3.8", status: "ok", findings: [], checkedAt: h(10), ...o });
  const vuln = (at: Date, v = "16.3.8"): NextEvent => ({ at, reason: "NextVulnerable", message: `shortly runs Next.js ${v} with 2 known vulnerabilities (critical)` });
  const clean = (at: Date, v = "16.4.1"): NextEvent => ({ at, reason: "NextClean", message: `shortly no longer has known Next.js vulnerabilities (now ${v})` });
  const of = (c: NextCheck | null, events: NextEvent[] = [], o: { cur?: Date | null; prev?: Date | null; framework?: string | null } = {}) =>
    previousNext({ currentLiveAt: o.cur === undefined ? curLive : o.cur, previousLiveAt: o.prev === undefined ? prevLive : o.prev, check: c, events, framework: o.framework });

  it("reads the stored check when it was made while the previous deployment was live", () => {
    expect(of(check())).toEqual({ status: "ok", version: "16.3.8" });
    expect(of(check({ status: "vulnerable", findings: [{ fixed: "16.4.1" }] }))).toEqual({ status: "vulnerable", version: "16.3.8" });
  });
  it("is unknown without deploy times, without any check, or when no check ran since the previous one went live", () => {
    expect(of(check(), [], { cur: null })).toEqual({ status: "unknown", version: null });
    expect(of(check(), [], { prev: null })).toEqual({ status: "unknown", version: null });
    expect(of(null)).toEqual({ status: "unknown", version: null });
    expect(of(check({ checkedAt: h(50) }))).toEqual({ status: "unknown", version: null });
    expect(of(check({ status: "unknown", version: null, reason: "version not exposed" }))).toEqual({ status: "unknown", version: null });
  });
  describe("after the current deploy's own check overwrote the row", () => {
    const after = (o: Partial<NextCheck> = {}) => check({ checkedAt: h(0.5), ...o });
    it("the last transition before the deploy gives the previous one's status (and its version when it was during its life)", () => {
      expect(of(after(), [vuln(h(30))])).toEqual({ status: "vulnerable", version: "16.3.8" });
      expect(of(after(), [vuln(h(100))])).toEqual({ status: "vulnerable", version: null });
      expect(of(after(), [vuln(h(100)), clean(h(30), "16.3.9")])).toEqual({ status: "ok", version: "16.3.9" });
    });
    it("a clean-up right after the deploy means the previous one had advisories (its own event may be pruned)", () => {
      expect(of(after({ version: "16.4.1" }), [clean(h(0.5))])).toEqual({ status: "vulnerable", version: null });
    });
    it("no transition at all: the previous one was like the live one", () => {
      expect(of(after())).toEqual({ status: "ok", version: null });
      expect(of(after({ status: "vulnerable", findings: [{ fixed: "16.4.1" }] }))).toEqual({ status: "vulnerable", version: null });
      expect(of(after({ status: "unknown", version: null, reason: "the site redirects to another host" }))).toEqual({ status: "unknown", version: null });
    });
    it("new advisories found after the deploy: unknown, unless the previous version is known (then judged by the fixes)", () => {
      const live = after({ status: "vulnerable", findings: [{ fixed: "16.4.1" }] });
      expect(of(live, [vuln(h(0.5))])).toEqual({ status: "unknown", version: null });
      expect(of(live, [clean(h(30), "16.3.9"), vuln(h(0.5))])).toEqual({ status: "vulnerable", version: "16.3.9" });
      expect(of(after({ status: "vulnerable", findings: [{ fixed: "16.3.2" }] }), [clean(h(30), "16.3.9"), vuln(h(0.5))])).toEqual({ status: "ok", version: "16.3.9" });
    });
    // Fix round 1 (review C1): the new deploy breaks the site, so its own check fails and keeps what it read before.
    it("a failed check after the deploy is judged by the version and findings it kept", () => {
      const failed = (o: Partial<NextCheck> = {}) => after({ status: "error", reason: "Couldn't load the site: HTTP 500", ...o });
      expect(of(failed())).toEqual({ status: "ok", version: null });
      expect(of(failed({ findings: [{ fixed: "16.4.1" }] }))).toEqual({ status: "vulnerable", version: null });
      expect(of(failed({ status: "unknown", reason: "version not exposed" }))).toEqual({ status: "ok", version: null });
      // The same row checked while the previous deployment was live (the direct path).
      expect(of(check({ status: "error" }))).toEqual({ status: "ok", version: "16.3.8" });
      expect(of(check({ status: "error", findings: [{ fixed: "16.4.1" }] }))).toEqual({ status: "vulnerable", version: "16.3.8" });
    });
    it("a previous deployment live for under an hour may never have been checked: unknown", () => {
      expect(of(after(), [], { prev: new Date(curLive.getTime() - 30 * 60_000) })).toEqual({ status: "unknown", version: null });
    });
  });
});

// Fix round 1 (review I1): a deployment without Next.js has no Next.js advisory.
describe("previousNext: apps that aren't Next.js, or never checked", () => {
  const notNext: NextCheck = { version: null, status: "unknown", findings: [], checkedAt: h(0.5), reason: "not a Next.js site" };
  it("not a Next.js site counts as ok, in either path", () => {
    expect(previousNext({ currentLiveAt: curLive, previousLiveAt: prevLive, check: notNext, events: [] })).toEqual({ status: "ok", version: null });
    expect(previousNext({ currentLiveAt: curLive, previousLiveAt: prevLive, check: { ...notNext, checkedAt: h(10) }, events: [] })).toEqual({ status: "ok", version: null });
  });
  it("version not exposed (nothing kept) stays unknown", () => {
    expect(previousNext({ currentLiveAt: curLive, previousLiveAt: prevLive, check: { ...notNext, reason: "version not exposed" }, events: [] })).toEqual({ status: "unknown", version: null });
  });
  // Fix round 2 (re-review I-1, M-1): a failed check writes its own reason, so after a broken deploy only the framework
  // still says it isn't Next.js; and not Next.js is ok whatever the deploy times.
  it("a non-Next.js app's failed after-deploy check (HTTP 500, nothing kept) is ok when the framework is another one", () => {
    const failed: NextCheck = { version: null, status: "error", findings: [], checkedAt: h(0.5), reason: "Couldn't load the site: HTTP 500" };
    const of = (framework: string | null, o: Partial<NextCheck> = {}, prev = prevLive) =>
      previousNext({ currentLiveAt: curLive, previousLiveAt: prev, check: { ...failed, ...o }, events: [], framework });
    expect(of("vite")).toEqual({ status: "ok", version: null });
    expect(of("vite", { checkedAt: h(10) })).toEqual({ status: "ok", version: null });
    for (const f of ["nextjs", null]) expect(of(f)).toEqual({ status: "unknown", version: null });
    // A kept version or finding is Next.js whatever Vercel says.
    expect(of("vite", { findings: [{ fixed: "16.4.1" }], version: "16.3.8" }).status).toBe("vulnerable");
    // Two deploys within an hour: still ok for a non-Next.js app (by the row or by the framework).
    const soon = new Date(curLive.getTime() - 30 * 60_000);
    expect(of("vite", {}, soon)).toEqual({ status: "ok", version: null });
    expect(previousNext({ currentLiveAt: curLive, previousLiveAt: soon, check: notNext, events: [] })).toEqual({ status: "ok", version: null });
  });
  it("never checked: ok for a project Vercel builds with another framework, otherwise unknown", () => {
    const never = (framework: string | null | undefined) => previousNext({ currentLiveAt: curLive, previousLiveAt: prevLive, check: null, events: [], framework });
    expect(never("vite")).toEqual({ status: "ok", version: null });
    for (const f of ["nextjs", "blitzjs", null, undefined, ""]) expect(never(f)).toEqual({ status: "unknown", version: null });
  });
});

describe("notes", () => {
  it("say what it likely is, within 200 characters", () => {
    const s = notTiedNote("HighLatency", new Date("2026-10-22T02:00:00Z"), new Date("2026-10-23T02:00:00Z"));
    expect(s).toBe("Slow since 22 Oct 09:00 WIB, not tied to a deploy (live since 23 Oct 09:00 WIB): check the app.");
    expect(notTiedNote("MonitorDown", new Date("2026-10-22T02:00:00Z"), null)).toBe("Down since 22 Oct 09:00 WIB, not tied to a deploy: check the app.");
    // Review M1: started after the deploy, but past the window.
    expect(notTiedNote("HighLatency", new Date("2026-10-22T03:05:00Z"), new Date("2026-10-22T02:25:00Z"), true))
      .toBe("Slow since 22 Oct 10:05 WIB, 40 min after the deploy went live, outside the rollback window: check the app or roll back by hand.");
    expect(notTiedNote("HighLatency", new Date("2026-10-22T08:00:00Z"), new Date("2026-10-22T02:00:00Z"), true)).toMatch(/, 6 h after the deploy/);
    // Re-review M-2: inside the window (no deployment to go back to, say), only when it started.
    expect(notTiedNote("HighLatency", new Date("2026-10-22T02:30:00Z"), new Date("2026-10-22T02:25:00Z")))
      .toBe("Slow since 22 Oct 09:30 WIB, started 5 min after the deploy went live: check the app.");
    expect(vulnerableNote("16.3.8")).toBe("No rollback: the previous deployment runs Next.js 16.3.8, which has known advisories.");
    expect(vulnerableNote(null)).toBe("No rollback: the previous deployment's Next.js has known advisories.");
    expect(UNKNOWN_NOTE.length).toBeLessThan(110);
  });
});
