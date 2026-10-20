import { describe, expect, it } from "vitest";
import type { VercelDeployment } from "@/lib/providers/vercel";
import { appState, deploymentEvent, monitorEvent, nextMonitorState, RECENT_MS } from "./rules";

const pass = { ok: true, statusCode: 200, latencyMs: 90, error: null };
const fail = { ok: false, statusCode: 502, latencyMs: 300, error: "HTTP 502" };
const at = new Date("2026-10-12T10:00:00Z");

describe("nextMonitorState", () => {
  it("is ok on a pass, warn for 1–2 failures in a row, err from the third", () => {
    expect(nextMonitorState(4, pass)).toEqual({ state: "ok", failStreak: 0 });
    expect(nextMonitorState(0, fail)).toEqual({ state: "warn", failStreak: 1 });
    expect(nextMonitorState(1, fail)).toEqual({ state: "warn", failStreak: 2 });
    expect(nextMonitorState(2, fail)).toEqual({ state: "err", failStreak: 3 });
  });
});

describe("appState", () => {
  it("ranks err over build over warn over ok, and is unknown without monitors", () => {
    expect(appState({ monitors: ["ok", "err"], building: true })).toBe("err");
    expect(appState({ monitors: ["ok"], building: true })).toBe("build");
    expect(appState({ monitors: ["ok", "warn"], building: false })).toBe("warn");
    expect(appState({ monitors: ["ok"], building: false })).toBe("ok");
    expect(appState({ monitors: [], building: false })).toBe("unknown");
  });
});

describe("monitorEvent: a body-rule failure", () => {
  const miss = { resourceId: "r1", path: "/health", code: 200, error: "Keyword not found", at };
  it("names the real cause, not HTTP 200", () => {
    expect(monitorEvent({ ...miss, prev: "warn", next: "err" })).toMatchObject({ message: "Monitor down", detail: "Keyword not found on 3 checks in a row" });
    expect(monitorEvent({ ...miss, prev: "ok", next: "warn" })).toMatchObject({ message: "Monitor degraded", detail: "Keyword not found" });
  });
  it("still words a timeout without a status from the error, and falls back to the code or No answer", () => {
    expect(monitorEvent({ ...miss, code: null, error: "No answer within 5 s", prev: "ok", next: "warn" })).toMatchObject({ detail: "No answer within 5 s" });
    expect(monitorEvent({ ...miss, error: null, prev: "ok", next: "warn" })).toMatchObject({ detail: "HTTP 200" });
    expect(monitorEvent({ ...miss, code: null, error: null, prev: "ok", next: "warn" })).toMatchObject({ detail: "No answer" });
  });
});

describe("monitorEvent", () => {
  const base = { resourceId: "r1", path: "/", code: 502, error: "HTTP 502", at };
  it("stays quiet on the first result and when nothing changed", () => {
    expect(monitorEvent({ ...base, prev: "unknown", next: "err" })).toBeNull();
    expect(monitorEvent({ ...base, prev: "warn", next: "warn" })).toBeNull();
  });
  it("describes down, degraded and recovered", () => {
    expect(monitorEvent({ ...base, prev: "warn", next: "err" })).toMatchObject({ type: "monitor", kind: "err", message: "Monitor down", detail: "HTTP 502 on 3 checks in a row" });
    expect(monitorEvent({ ...base, prev: "ok", next: "warn" })).toMatchObject({ kind: "warn", message: "Monitor degraded", detail: "HTTP 502" });
    expect(monitorEvent({ ...base, prev: "err", next: "ok", code: 200, error: null })).toMatchObject({ kind: "ok", message: "Monitor recovered", detail: "/ answers again" });
    expect(monitorEvent({ ...base, prev: "ok", next: "warn", code: null, error: "No answer within 5 s" })).toMatchObject({ detail: "No answer within 5 s" });
  });
  it("words a heartbeat's change from its state text, not as failed checks (U3)", () => {
    const hb = { resourceId: "r1", path: "backup job", code: null, at, heartbeat: true };
    expect(monitorEvent({ ...hb, prev: "warn", next: "err", error: "Down · no ping for 2 h" })).toMatchObject({ kind: "err", message: "Monitor down", detail: "Down · no ping for 2 h" });
    expect(monitorEvent({ ...hb, prev: "ok", next: "warn", error: "Late · last ping 1 h ago" })).toMatchObject({ kind: "warn", detail: "Late · last ping 1 h ago" });
    expect(monitorEvent({ ...hb, prev: "err", next: "ok", error: "Up · pinged 1 min ago" })).toMatchObject({ kind: "ok", message: "Monitor recovered", detail: "backup job pinged again" });
  });
  it("writes the down event of a heartbeat that was still waiting or just resumed, but nothing else from unknown (5b final review M2)", () => {
    const hb = { resourceId: "r1", path: "backup job", code: null, at, heartbeat: true };
    expect(monitorEvent({ ...hb, prev: "unknown", next: "err", error: "Down · never pinged" })).toMatchObject({ kind: "err", message: "Monitor down", detail: "Down · never pinged" });
    expect(monitorEvent({ ...hb, prev: "unknown", next: "ok", error: "Up · pinged 1 min ago" })).toBeNull();
    expect(monitorEvent({ ...hb, prev: "unknown", next: "warn", error: "Late · last ping 1 h ago" })).toBeNull();
    // An HTTP monitor's first result stays quiet, as before.
    expect(monitorEvent({ resourceId: "r1", path: "/", code: 502, error: "HTTP 502", at, prev: "unknown", next: "err" })).toBeNull();
  });
});

describe("deploymentEvent", () => {
  const d = (over: Partial<VercelDeployment>): VercelDeployment => ({
    id: "d1", projectId: "p1", state: "building", rawState: "BUILDING", target: "production", branch: "main", sha: "a3f91c2aa", message: "feat", source: "git", url: null,
    createdAt: new Date(at.getTime() - 60_000), buildingAt: null, readyAt: null, ...over,
  });
  it("reports a new build, and a ready or failed one that just happened", () => {
    expect(deploymentEvent(undefined, d({}), "r1", at)).toMatchObject({ type: "deployment", kind: "build", message: "Deployment started", detail: "main · a3f91c2" });
    expect(deploymentEvent("building", d({ state: "ready", readyAt: at }), "r1", at)).toMatchObject({ kind: "ok", message: "Deployment ready" });
    expect(deploymentEvent("building", d({ state: "error" }), "r1", at)).toMatchObject({ kind: "fail", message: "Deployment failed" });
  });
  it("ignores history on the first run and unchanged states", () => {
    const old = new Date(at.getTime() - 3_600_000);
    expect(deploymentEvent(undefined, d({ state: "ready", createdAt: old, readyAt: old }), "r1", at)).toBeNull();
    expect(deploymentEvent("ready", d({ state: "ready", readyAt: at }), "r1", at)).toBeNull();
  });
  it("on first sight, a build only counts when it was created in the last 10 minutes", () => {
    expect(deploymentEvent(undefined, d({ createdAt: new Date(at.getTime() - 3_600_000) }), "r1", at)).toBeNull();
    expect(deploymentEvent(undefined, d({ createdAt: new Date(at.getTime() - RECENT_MS) }), "r1", at)).toMatchObject({ kind: "build" });
  });
  it("on first sight, a finished deployment counts only when it finished recently", () => {
    expect(deploymentEvent(undefined, d({ state: "ready", readyAt: new Date(at.getTime() - 120_000) }), "r1", at)).toMatchObject({ kind: "ok", message: "Deployment ready" });
    expect(deploymentEvent(undefined, d({ state: "error", createdAt: new Date(at.getTime() - 120_000), readyAt: null }), "r1", at)).toMatchObject({ kind: "fail", message: "Deployment failed" });
    expect(deploymentEvent(undefined, d({ state: "error", createdAt: new Date(at.getTime() - 3_600_000), readyAt: null }), "r1", at)).toBeNull();
    expect(deploymentEvent(undefined, d({ state: "canceled", createdAt: new Date(at.getTime() - 3_600_000), readyAt: null }), "r1", at)).toBeNull();
  });
  it("counts a ready deployment at exactly the 10-minute mark, and not one millisecond past it", () => {
    expect(deploymentEvent(undefined, d({ state: "ready", readyAt: new Date(at.getTime() - RECENT_MS) }), "r1", at)).toMatchObject({ kind: "ok" });
    expect(deploymentEvent(undefined, d({ state: "ready", readyAt: new Date(at.getTime() - RECENT_MS - 1) }), "r1", at)).toBeNull();
  });
});

describe("appState with a linked database (D7)", () => {
  it("is degraded while the linked database is paused, unless something worse is going on", () => {
    expect(appState({ monitors: ["ok"], building: false, dbPaused: true })).toBe("warn");
    expect(appState({ monitors: [], building: false, dbPaused: true })).toBe("warn");
    expect(appState({ monitors: ["err"], building: false, dbPaused: true })).toBe("err");
    expect(appState({ monitors: ["ok"], building: true, dbPaused: true })).toBe("build");
    expect(appState({ monitors: ["ok"], building: false, dbPaused: false })).toBe("ok");
  });
});
