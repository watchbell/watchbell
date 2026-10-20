import { describe, expect, it } from "vitest";
import { checksVerdict, httpVerdict, isAuthWall, logsVerdict, smokePaths, stageLine, type WatchInput, watchDue, watchStep } from "./pr-watch";

const now = new Date("2026-10-16T10:00:00Z");
const min = (m: number) => new Date(now.getTime() - m * 60_000);
const SHA = "a".repeat(40);
const w = (o: Partial<WatchInput> = {}): WatchInput => ({
  now, openedAt: min(10), pr: { state: "open", merged: false, mergeable: true, headSha: SHA }, recordedSha: SHA, checks: "success",
  preview: { state: "ready", readyAt: min(5) }, smoke: { mode: "http", result: "pass", reason: null }, autoRollbackOn: true, ...o,
});

describe("watchStep", () => {
  it("pending → waits at each stage, then merges when everything is green", () => {
    expect(watchStep(w({ checks: "pending" }))).toEqual({ kind: "wait", stage: "checks", reason: null });
    expect(watchStep(w({ pr: { state: "open", merged: false, mergeable: null, headSha: SHA } }))).toMatchObject({ kind: "wait", stage: "checks" });
    expect(watchStep(w({ preview: { state: "building", readyAt: null }, smoke: null }))).toEqual({ kind: "wait", stage: "preview", reason: null });
    expect(watchStep(w({ smoke: { mode: "logs", result: "wait", reason: null } }))).toEqual({ kind: "wait", stage: "smoke", reason: null });
    expect(watchStep(w())).toEqual({ kind: "merge" });
  });
  it("fail: CI, a conflict, a failed preview, a failed smoke test", () => {
    expect(watchStep(w({ checks: "failure" }))).toEqual({ kind: "stop", stage: "failed", reason: "CI failed" });
    expect(watchStep(w({ pr: { state: "open", merged: false, mergeable: false, headSha: SHA } }))).toMatchObject({ kind: "stop", reason: "conflicts with the main branch" });
    expect(watchStep(w({ preview: { state: "error", readyAt: null } }))).toMatchObject({ kind: "stop", reason: "Vercel preview failed" });
    expect(watchStep(w({ smoke: { mode: "http", result: "fail", reason: "/ answered 500" } }))).toEqual({ kind: "stop", stage: "failed", reason: "preview smoke test failed: / answered 500" });
  });
  it("timeout after 45 minutes while still waiting", () => {
    expect(watchStep(w({ openedAt: min(46), checks: "pending" }))).toMatchObject({ kind: "stop", stage: "timeout" });
    expect(watchStep(w({ openedAt: min(46), preview: { state: "building", readyAt: null }, smoke: null }))).toMatchObject({ kind: "stop", stage: "timeout" });
    expect(watchStep(w({ openedAt: min(44), checks: "pending" }))).toMatchObject({ kind: "wait" });
    expect(watchStep(w({ openedAt: min(90) }))).toEqual({ kind: "merge" });
  });
  it("sha changed: the checks start again on the new commit", () => {
    const next = "b".repeat(40);
    expect(watchStep(w({ pr: { state: "open", merged: false, mergeable: true, headSha: next } }))).toEqual({ kind: "wait", stage: "checks", reason: "new commit on the PR branch, checking again", resetSha: next });
  });
  it("auto-rollback off: stops ready for a manual merge", () => {
    expect(watchStep(w({ autoRollbackOn: false }))).toEqual({ kind: "stop", stage: "ready-manual", reason: "PR is ready to merge, but auto-rollback is off; merge it manually" });
  });
  it("merged or closed by someone: done", () => {
    expect(watchStep(w({ pr: { state: "closed", merged: true, mergeable: null, headSha: SHA } }))).toEqual({ kind: "done", stage: "merged" });
    expect(watchStep(w({ pr: { state: "closed", merged: false, mergeable: null, headSha: SHA } }))).toEqual({ kind: "done", stage: "closed" });
  });
});

describe("checksVerdict", () => {
  const run = (status: string, conclusion: string | null) => ({ status, conclusion });
  it("neutral and skipped count as ok; anything running waits; any failure fails", () => {
    expect(checksVerdict({ checkRuns: [run("completed", "success"), run("completed", "neutral"), run("completed", "skipped")], combined: { state: "success", total: 1 }, actionRuns: null })).toBe("success");
    expect(checksVerdict({ checkRuns: [run("in_progress", null)], combined: null, actionRuns: null })).toBe("pending");
    expect(checksVerdict({ checkRuns: [run("completed", "failure"), run("queued", null)], combined: null, actionRuns: null })).toBe("failure");
    expect(checksVerdict({ checkRuns: [], combined: { state: "failure", total: 2 }, actionRuns: null })).toBe("failure");
  });
  it("a commit without any statuses isn't pending; unreadable checks fall back to Actions runs", () => {
    expect(checksVerdict({ checkRuns: [], combined: { state: "pending", total: 0 }, actionRuns: null })).toBe("success");
    expect(checksVerdict({ checkRuns: null, combined: null, actionRuns: [run("completed", "timed_out")] })).toBe("failure");
    expect(checksVerdict({ checkRuns: null, combined: null, actionRuns: null })).toBe("success");
  });
});

describe("smoke modes", () => {
  const h = (o: Record<string, string> = {}) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });
  it("HTTP: every path 200–399 passes; a 5xx or no answer fails", () => {
    expect(httpVerdict([{ path: "/", status: 200, ms: 300, authWall: false }, { path: "/api/health", status: 307, ms: 90, authWall: false }])).toEqual({ mode: "http", result: "pass", reason: null });
    expect(httpVerdict([{ path: "/", status: 500, ms: 300, authWall: false }])).toEqual({ mode: "http", result: "fail", reason: "/ answered 500" });
    expect(httpVerdict([{ path: "/x", status: null, ms: 15000, authWall: false }])?.reason).toBe("/x didn't answer within 15 seconds");
  });
  it("behind Vercel Authentication the HTTP part is skipped and the logs decide", () => {
    expect(isAuthWall(401, "<title>Authentication Required</title> vercel.com/sso", h())).toBe(true);
    expect(isAuthWall(403, "", h({ "set-cookie": "_vercel_sso_nonce=x" }))).toBe(true);
    expect(isAuthWall(500, "Authentication Required", h())).toBe(false);
    expect(httpVerdict([{ path: "/", status: 401, ms: 50, authWall: true }])).toBeNull();
    expect(logsVerdict(min(2), now, 0)).toEqual({ mode: "logs", result: "wait", reason: null });
    expect(logsVerdict(min(4), now, 0)).toEqual({ mode: "logs", result: "pass", reason: null });
    expect(logsVerdict(min(4), now, 2)).toEqual({ mode: "logs", result: "fail", reason: "2 errors in the preview logs" });
    expect(logsVerdict(min(4), now, null).result).toBe("wait");
  });
  it("probes / and up to 3 monitor paths", () => {
    expect(smokePaths(["https://a.example/api/health?x=1", "https://a.example/", "https://a.example/login", "https://a.example/a", "https://a.example/b", "nope"])).toEqual(["/", "/api/health", "/login", "/a"]);
  });
});

describe("throttle and text", () => {
  it("every 2 minutes", () => {
    const even = new Date("2026-10-16T10:02:10Z");
    expect(watchDue(even, null)).toBe(true);
    expect(watchDue(new Date("2026-10-16T10:03:10Z"), null)).toBe(false);
    expect(watchDue(new Date("2026-10-16T10:03:10Z"), even.getTime())).toBe(false);
    expect(watchDue(new Date("2026-10-16T10:04:05Z"), even.getTime())).toBe(true);
  });
  it("stage lines", () => {
    expect(stageLine(12, "preview")).toBe("PR #12: waiting for preview");
    expect(stageLine(12, "merged")).toBe("PR #12: merged ✅");
    expect(stageLine(12, "failed", "CI failed")).toBe("PR #12: needs a look ⚠️ — CI failed");
  });
});
