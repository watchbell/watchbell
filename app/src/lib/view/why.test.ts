import { describe, expect, it } from "vitest";
import { onlyJobs, problemsOf, whyTitle, type WhyApp, type WhyMonitor } from "./why";

const now = new Date("2026-10-12T10:00:00Z");
const since = new Date("2026-10-12T07:00:00Z");
const http = (o: Partial<WhyMonitor> = {}): WhyMonitor => ({ id: "m1", path: "/api/health", state: "err", lastStatus: 502, lastError: "HTTP 502", paused: false, ownerPaused: false, stateSince: since, ...o });
const hb = (o: Partial<WhyMonitor> = {}): WhyMonitor => ({ id: "h1", path: "www", name: "www", kind: "heartbeat", state: "warn", lastStatus: null, lastError: "Late · last ping 6 min ago", paused: false, ownerPaused: false, stateSince: since, ...o });
const app = (o: Partial<WhyApp> = {}): WhyApp => ({ gone: false, monitors: [], ...o });

describe("problemsOf", () => {
  it("is empty for a healthy app, a gone app, and monitors that are paused, in a window or fine", () => {
    expect(problemsOf(app({ monitors: [http({ state: "ok" })] }), now)).toEqual([]);
    expect(problemsOf(app({ gone: true, monitors: [http()] }), now)).toEqual([]);
    expect(problemsOf(app({ monitors: [http({ ownerPaused: true }), http({ maintUntil: now })] }), now)).toEqual([]);
  });
  it("names a late heartbeat with where, reason, since and the scheduler remedies", () => {
    const [p] = problemsOf(app({ monitors: [hb()] }), now);
    expect(p).toMatchObject({ kind: "monitor", where: "Monitor www (heartbeat)", state: "warn", reason: "last ping 6 min ago", since, href: "/uptime" });
    expect(p.remedies[0]).toMatch(/scheduler ran/);
    expect(p.remedies.join(" ")).toMatch(/pause or delete the heartbeat/);
  });
  it("tells the heartbeat causes apart: no ping, reported failure, started but not finished", () => {
    const r = (lastError: string) => problemsOf(app({ monitors: [hb({ state: "err", lastError })] }), now)[0];
    expect(r("Down · no ping for 2 h")).toMatchObject({ reason: "no ping for 2 h" });
    expect(r("Down · no ping for 2 h").remedies[0]).toMatch(/scheduler/);
    expect(r("Down · the job reported a failure").remedies[0]).toMatch(/reported a failure/);
    expect(r("Down · started but didn't finish").remedies[0]).toMatch(/hung|timeout/);
  });
  it("gives HTTP remedies by cause", () => {
    const one = (o: Partial<WhyMonitor>) => problemsOf(app({ monitors: [http(o)] }), now)[0];
    expect(one({}).where).toBe("Monitor /api/health");
    expect(one({}).remedies[0]).toMatch(/Logs/);
    expect(one({}).remedies[1]).toMatch(/roll back/);
    expect(one({ lastStatus: 404, lastError: "HTTP 404" }).remedies[0]).toMatch(/expected status/);
    expect(one({ lastStatus: null, lastError: "Timed out" }).remedies[0]).toMatch(/DNS/);
    expect(one({ lastStatus: null, lastError: "Blocked address" })).toMatchObject({ reason: "Blocked address" });
    expect(one({ lastStatus: null, lastError: "Blocked address" }).remedies[0]).toMatch(/private address/);
    const kw = one({ lastStatus: 200, lastError: "Keyword not found" });
    expect(kw.reason).toBe("Keyword not found");
    expect(kw.remedies[0]).toMatch(/content changed/);
  });
  it("lists the website's monitors before jobs, down before late, then the database and a failed deploy", () => {
    const list = problemsOf(app({
      stateSince: since, dbPaused: true, database: { id: "d1", kind: "supabase_project", name: "db-a" },
      lastDeploy: { state: "error", commitSha: "8b3de80aaaa", createdAt: since },
      monitors: [hb({ state: "err", lastError: "Down · no ping" }), http({ state: "warn", lastStatus: 200, lastError: "HTTP 200", path: "/slow" }), http()],
    }), now);
    expect(list.map((p) => p.where)).toEqual(["Monitor /api/health", "Monitor /slow", "Monitor www (heartbeat)", "Database db-a", "Production deployment 8b3de80"]);
    expect(list[3]).toMatchObject({ href: "/supabase", reason: "Paused", remedies: ["Restore the database from its provider (Supabase restore)"] });
    expect(list[4]).toMatchObject({ href: "/deployments", remedies: ["Open the deployment's build logs; redeploy after fixing"] });
  });
  it("onlyJobs is true only when every problem is a heartbeat", () => {
    expect(onlyJobs(problemsOf(app({ monitors: [hb()] }), now))).toBe(true);
    expect(onlyJobs(problemsOf(app({ monitors: [hb(), http()] }), now))).toBe(false);
    expect(onlyJobs([])).toBe(false);
  });
  it("titles the popover with the state word", () => {
    expect(whyTitle("warn")).toBe("Why degraded");
    expect(whyTitle("err")).toBe("Why down");
  });
});
