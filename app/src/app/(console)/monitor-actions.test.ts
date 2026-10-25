import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const member = { id: "mem-1", userId: "user-1", email: "op@example.com", role: "operator" as const };

const h = vi.hoisted(() => ({
  requireActionMember: vi.fn(),
  limit: vi.fn(),
  refresh: vi.fn(),
  recordAction: vi.fn(),
  createMonitor: vi.fn(),
  updateMonitor: vi.fn(),
  setMonitorPaused: vi.fn(),
  setAppMonitorsPaused: vi.fn(),
  deleteMonitor: vi.fn(),
  checkMonitorNow: vi.fn(),
  runCollector: vi.fn(),
  createHeartbeat: vi.fn(),
  updateHeartbeat: vi.fn(),
  rotateToken: vi.fn(),
  recordTestPing: vi.fn(),
  moveMonitorToDomain: vi.fn(),
}));
vi.mock("@/lib/data/monitor-move-db", () => ({ moveMonitorToDomain: h.moveMonitorToDomain }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/data/monitors-db", () => ({
  createMonitor: h.createMonitor, updateMonitor: h.updateMonitor, setMonitorPaused: h.setMonitorPaused,
  setAppMonitorsPaused: h.setAppMonitorsPaused, deleteMonitor: h.deleteMonitor, checkMonitorNow: h.checkMonitorNow,
  createHeartbeat: h.createHeartbeat, updateHeartbeat: h.updateHeartbeat, rotateToken: h.rotateToken, recordTestPing: h.recordTestPing,
}));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ SITE_URL: "https://ops.example.com/" }) }));
vi.mock("@/lib/collector/run", () => ({ runCollector: h.runCollector }));

import { LIMITS } from "@/lib/rate-limit";
import { addHeartbeat, addMonitor, checkNow, editHeartbeat, editMonitor, newPingUrl, pauseAppMonitors, pauseMonitor, recordTestPingAction, removeMonitor, updateMonitorDomain } from "./monitor-actions";
import { refreshNow } from "./refresh-action";

const form = { url: "https://web.example.com/api/health", expectedStatus: "200", timeoutS: "5" };
const audit = { message: "Monitor added: web.example.com/api/health", resourceId: "a1" };
const done = (extra: Record<string, unknown> = {}) => ({ ok: true, message: "Done.", audit, ...extra });

// Every write action, with a valid call and the db function it must reach.
const writes = [
  ["addMonitor", () => addMonitor(UUID, form), () => h.createMonitor, () => addMonitor("nope", form)],
  ["editMonitor", () => editMonitor(UUID, form), () => h.updateMonitor, () => editMonitor("nope", form)],
  ["pauseMonitor", () => pauseMonitor(UUID, true), () => h.setMonitorPaused, () => pauseMonitor("nope", true)],
  ["pauseAppMonitors", () => pauseAppMonitors(UUID, true), () => h.setAppMonitorsPaused, () => pauseAppMonitors("nope", true)],
  ["removeMonitor", () => removeMonitor(UUID), () => h.deleteMonitor, () => removeMonitor("nope")],
  ["recordTestPingAction", () => recordTestPingAction(UUID, "ok"), () => h.recordTestPing, () => recordTestPingAction("nope", "ok")],
  ["updateMonitorDomain", () => updateMonitorDomain(UUID), () => h.moveMonitorToDomain, () => updateMonitorDomain("nope")], // Watchbell 1.2.1
] as const;
const all = [...writes, ["checkNow", () => checkNow(UUID), () => h.checkMonitorNow, () => checkNow("nope")]] as const;

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(member);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  for (const fn of [h.createMonitor, h.updateMonitor, h.setMonitorPaused, h.setAppMonitorsPaused, h.deleteMonitor, h.checkMonitorNow, h.recordTestPing, h.moveMonitorToDomain]) fn.mockResolvedValue(done());
  h.recordAction.mockResolvedValue(undefined);
  h.runCollector.mockResolvedValue({ skipped: false, ok: true });
});

describe.each(all)("%s", (_name, call, target, bad) => {
  it("needs an operator: a viewer is refused before any limit, database call or refresh", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await call()).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("operator");
    expect(h.limit).not.toHaveBeenCalled();
    expect(target()).not.toHaveBeenCalled();
    expect(h.recordAction).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("rejects a malformed id before the limit and the database", async () => {
    expect(await bad()).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(h.limit).not.toHaveBeenCalled();
    expect(target()).not.toHaveBeenCalled();
  });

  it("refreshes the page and records who did it, only on success", async () => {
    expect(await call()).toMatchObject({ ok: true, message: "Done.", data: { passed: true } });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", ...audit, actorUserId: "user-1" });
  });

  it("neither refreshes nor records when the action is refused", async () => {
    target().mockResolvedValue({ ok: false, error: "No." });
    expect(await call()).toEqual({ ok: false, error: "No." });
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.recordAction).not.toHaveBeenCalled();
  });

  it("keeps working when the audit entry can't be written", async () => {
    h.recordAction.mockRejectedValue(new Error("db down"));
    expect(await call()).toMatchObject({ ok: true });
  });
});

describe.each(writes)("%s write limit", (_name, call, target) => {
  it("is limited per member to 60 changes in 10 minutes", async () => {
    await call();
    expect(h.limit).toHaveBeenCalledWith(LIMITS.monitorWrite, "mem-1");
  });

  it("stops at the limit without touching the database", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 90 });
    expect(await call()).toEqual({ ok: false, error: "Too many changes. Try again in 2 minutes." });
    expect(target()).not.toHaveBeenCalled();
  });
});

describe("form actions", () => {
  it("rejects a bad form with field errors, before the limit", async () => {
    const r = await addMonitor(UUID, { ...form, url: "https://127.0.0.1/" });
    expect(r).toEqual({ ok: false, error: "Check the highlighted fields.", fieldErrors: { url: "Use a public https address." } });
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.createMonitor).not.toHaveBeenCalled();
    const e = await editMonitor(UUID, { ...form, expectedStatus: "999" });
    expect(e).toMatchObject({ ok: false, fieldErrors: { expectedStatus: expect.any(String) } });
    expect(h.updateMonitor).not.toHaveBeenCalled();
  });

  it("hands the parsed values, not the raw form, to the database", async () => {
    await addMonitor(UUID, form);
    expect(h.createMonitor).toHaveBeenCalledWith(UUID, {
      url: "https://web.example.com/api/health", expectedStatus: 200, timeoutMs: 5000, bodyContains: null, jsonPath: null, jsonEquals: null,
    });
  });

  it("pause actions reject a non-boolean flag", async () => {
    expect(await pauseMonitor(UUID, "yes" as unknown as boolean)).toMatchObject({ ok: false });
    expect(await pauseAppMonitors(UUID, 1 as unknown as boolean)).toMatchObject({ ok: false });
    expect(h.setMonitorPaused).not.toHaveBeenCalled();
    expect(h.setAppMonitorsPaused).not.toHaveBeenCalled();
  });
});

describe("checkNow", () => {
  it("has its own limit of 30 in 10 minutes", async () => {
    await checkNow(UUID);
    expect(h.limit).toHaveBeenCalledWith(LIMITS.check, "mem-1");
  });

  it("stops at the limit before it fetches anything", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 30 });
    expect(await checkNow(UUID)).toEqual({ ok: false, error: "Too many checks. Try again in 1 minute." });
    expect(h.checkMonitorNow).not.toHaveBeenCalled();
  });

  it("carries a failed check as passed: false, and records it as an error entry", async () => {
    h.checkMonitorNow.mockResolvedValue(done({ passed: false }));
    expect(await checkNow(UUID)).toMatchObject({ ok: true, data: { passed: false } });
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "err", actorUserId: "user-1" }));
  });
});

describe("refreshNow", () => {
  it("needs an operator and is limited to 10 in 10 minutes", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await refreshNow()).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.runCollector).not.toHaveBeenCalled();
    h.requireActionMember.mockResolvedValue(member);
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 600 });
    expect(await refreshNow()).toEqual({ ok: false, error: "Too many refreshes. Try again in 10 minutes." });
    expect(h.limit).toHaveBeenCalledWith(LIMITS.refresh, "mem-1");
    expect(h.runCollector).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("runs the collector, refreshes, and records who asked", async () => {
    expect(await refreshNow()).toEqual({ ok: true, message: "Collector run requested. New data arrives within a few seconds." });
    expect(h.runCollector).toHaveBeenCalledWith("manual");
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "Collector run requested", resourceId: null, actorUserId: "user-1" });
  });

  it("says when a run is already going, and records an error entry when the run failed", async () => {
    h.runCollector.mockResolvedValue({ skipped: true, ok: false });
    expect(await refreshNow()).toMatchObject({ ok: true, message: "A collector run is already going. New data arrives within a few seconds." });
    expect(h.recordAction).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "ok" }));
    h.runCollector.mockResolvedValue({ skipped: false, ok: false });
    await refreshNow();
    expect(h.recordAction).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "err" }));
  });
});

describe("heartbeat actions (U3)", () => {
  const T = "hb_0123456789abcdef0123456789abcdef";
  const hbForm = { name: "backup job", periodS: "86400", graceS: "3600" };
  const hbAudit = { message: "Heartbeat added: backup job", resourceId: "a1" };
  const calls = [
    ["addHeartbeat", () => addHeartbeat(UUID, hbForm), () => h.createHeartbeat, () => addHeartbeat("nope", hbForm)],
    ["editHeartbeat", () => editHeartbeat(UUID, hbForm), () => h.updateHeartbeat, () => editHeartbeat("nope", hbForm)],
    ["newPingUrl", () => newPingUrl(UUID), () => h.rotateToken, () => newPingUrl("nope")],
  ] as const;

  beforeEach(() => {
    for (const fn of [h.createHeartbeat, h.updateHeartbeat, h.rotateToken]) fn.mockResolvedValue({ ok: true, message: "Done.", audit: hbAudit, token: T });
  });

  it.each(calls)("%s needs an operator, a valid id and the write quota", async (_n, call, target, bad) => {
    h.requireActionMember.mockRejectedValueOnce(new AuthError("forbidden"));
    expect(await call()).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(await bad()).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(target()).not.toHaveBeenCalled();
    h.limit.mockResolvedValueOnce({ allowed: false, retryAfter: 90 });
    expect(await call()).toEqual({ ok: false, error: "Too many changes. Try again in 2 minutes." });
    expect(h.limit).toHaveBeenCalledWith(LIMITS.monitorWrite, "mem-1");
    expect(target()).not.toHaveBeenCalled();
  });

  it.each(calls)("%s answers with the ping URL once, and the audit entry never carries the token", async (_n, call) => {
    expect(await call()).toEqual({ ok: true, message: "Done.", data: { pingUrl: `https://ops.example.com/api/ping/${T}` } });
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", ...hbAudit, actorUserId: "user-1" });
    expect(JSON.stringify(h.recordAction.mock.calls)).not.toContain(T);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("an edit without a new token answers without a URL", async () => {
    h.updateHeartbeat.mockResolvedValue({ ok: true, message: "Saved backup job.", audit: hbAudit });
    expect(await editHeartbeat(UUID, hbForm)).toEqual({ ok: true, message: "Saved backup job.", data: { pingUrl: null } });
  });

  it("checks the form before the limit, and hands the parsed values on", async () => {
    expect(await addHeartbeat(UUID, { name: "", periodS: "60", graceS: "3600" })).toEqual({
      ok: false, error: "Check the highlighted fields.", fieldErrors: { name: "Name the job, like backup job.", periodS: "Pick how often the job runs." },
    });
    expect(h.limit).not.toHaveBeenCalled();
    await addHeartbeat(UUID, { ...hbForm, name: "  backup job " });
    expect(h.createHeartbeat).toHaveBeenCalledWith(UUID, { name: "backup job", periodS: 86_400, graceS: 3600 });
  });

  it("passes a refusal on without a URL, a refresh or an audit entry", async () => {
    h.rotateToken.mockResolvedValue({ ok: false, error: "That monitor isn't a heartbeat." });
    expect(await newPingUrl(UUID)).toEqual({ ok: false, error: "That monitor isn't a heartbeat." });
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.recordAction).not.toHaveBeenCalled();
  });
});

describe("recordTestPingAction", () => {
  it("passes the kind and the monitor id (never a token) to the database", async () => {
    await recordTestPingAction(UUID, "fail");
    expect(h.recordTestPing).toHaveBeenCalledWith(UUID, "fail");
  });

  it("rejects any other kind before the limit and the database", async () => {
    expect(await recordTestPingAction(UUID, "start" as unknown as "ok")).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.recordTestPing).not.toHaveBeenCalled();
  });
});
