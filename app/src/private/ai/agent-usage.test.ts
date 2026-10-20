import { describe, expect, it } from "vitest";
import {
  ACTIVITY_STALE_MS, type AgentRun, limitBars, modelFamily, parseActivity, parseLimitInput, parseLimits, runRecord, runTimeProblem,
} from "./agent-usage";

const now = new Date("2026-10-13T10:00:00Z");
const key = { keyId: "k1", client: { name: "antigravity", version: "1.3", via: "mcp" as const, userAgent: "ua" } };
const run = (o: Partial<AgentRun> = {}): AgentRun => ({
  model: "gemini-3.8-flash", purpose: "ask", status: "ok", inputTokens: 2000, cachedTokens: 18000, outputTokens: 300, thinkingTokens: 120, durationMs: 4200, ...o,
});

describe("runRecord: one report_usage run → one ai_usage row", () => {
  it("maps tokens, purpose and duration onto an 'agent' row of the caller", () => {
    expect(runRecord(run({ at: "2026-10-13T09:58:00+00:00" }), key, now)).toEqual({
      at: new Date("2026-10-13T09:58:00Z"), keyId: "k1", client: key.client, providerId: null, model: "gemini-3.8-flash", kind: "agent", tool: "ask",
      tokensIn: 2000, tokensCached: 18000, tokensOut: 300, tokensThinking: 120, latencyMs: 4200, status: 200, errorClass: null, stream: false,
    });
  });
  it("defaults the time to now and maps error/limit to 500/agent_error and 429/quota", () => {
    expect(runRecord(run({ status: "error" }), key, now)).toMatchObject({ at: now, status: 500, errorClass: "agent_error" });
    expect(runRecord(run({ status: "limit", purpose: "advisor" }), key, now)).toMatchObject({ status: 429, errorClass: "quota", tool: "advisor" });
  });
});

describe("runTimeProblem", () => {
  it("accepts now and up to 24 h back, plus a minute of clock skew", () => {
    expect(runTimeProblem(undefined, now)).toBeNull();
    expect(runTimeProblem("2026-10-13T10:00:30Z", now)).toBeNull();
    expect(runTimeProblem("2026-10-12T10:00:00Z", now)).toBeNull();
  });
  it("rejects the future and anything older than 24 h", () => {
    expect(runTimeProblem("2026-10-13T10:05:00Z", now)).toMatch(/future/);
    expect(runTimeProblem("2026-10-12T09:59:00Z", now)).toMatch(/24 h/);
  });
});

describe("parseActivity (ops.settings antigravity.activity)", () => {
  const running = { model: "claude-sonnet-4-6", purpose: "ask", startedAt: "2026-10-13T09:58:00.000Z", questions: 2 };
  it("returns the run in progress", () => {
    expect(parseActivity({ running, updatedAt: "2026-10-13T09:58:00.000Z" }, now)).toEqual({ running, updatedAt: "2026-10-13T09:58:00.000Z" });
  });
  it("treats a run older than 15 minutes as stale (idle)", () => {
    const old = new Date(now.getTime() - ACTIVITY_STALE_MS - 1000).toISOString();
    expect(parseActivity({ running: { ...running, startedAt: old }, updatedAt: old }, now)?.running).toBeNull();
  });
  it("is null for junk and keeps idle values", () => {
    expect(parseActivity(null, now)).toBeNull();
    expect(parseActivity({ running: { model: "Bad Id", purpose: "ask", startedAt: running.startedAt }, updatedAt: running.startedAt }, now)?.running).toBeNull();
    expect(parseActivity({ running: null, updatedAt: "2026-10-13T09:59:00.000Z" }, now)).toEqual({ running: null, updatedAt: "2026-10-13T09:59:00.000Z" });
    expect(parseActivity({ running: null, updatedAt: "nope" }, now)).toBeNull();
  });
});

describe("modelFamily", () => {
  it("is gemini or claude by prefix, ignoring ag/ and provider prefixes", () => {
    expect(modelFamily("gemini-3.8-flash-high")).toBe("gemini");
    expect(modelFamily("ag/claude-opus-4-6-thinking")).toBe("claude");
    expect(modelFamily("google/gemini-3.8-pro")).toBe("gemini");
    expect(modelFamily("gpt-oss-120b")).toBeNull();
    expect(modelFamily(null)).toBeNull();
  });
});

describe("limits (ops.settings antigravity.limits)", () => {
  it("parses stored limits, dropping anything that isn't a positive integer", () => {
    expect(parseLimits({ gemini5h: 1_000_000, geminiWeek: "x", claude5h: -1, claudeWeek: 2.5 })).toEqual({ gemini5h: 1_000_000, geminiWeek: null, claude5h: null, claudeWeek: null });
    expect(parseLimits(null)).toEqual({ gemini5h: null, geminiWeek: null, claude5h: null, claudeWeek: null });
  });
  it("reads a form field: blank = no limit, digits with separators, bounded", () => {
    expect(parseLimitInput("")).toEqual({ ok: true, value: null });
    expect(parseLimitInput("  ")).toEqual({ ok: true, value: null });
    expect(parseLimitInput("1,500,000")).toEqual({ ok: true, value: 1_500_000 });
    expect(parseLimitInput("2 000 000")).toEqual({ ok: true, value: 2_000_000 });
    expect(parseLimitInput("0").ok).toBe(false);
    expect(parseLimitInput("1e6").ok).toBe(false);
    expect(parseLimitInput("-5").ok).toBe(false);
    expect(parseLimitInput("10000000000000").ok).toBe(false);
    expect(parseLimitInput(null)).toEqual({ ok: true, value: null });
  });
});

describe("limitBars: rolling windows by family, cached excluded", () => {
  const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000);
  const rows = [
    { at: at(30), model: "gemini-3.8-flash", tokensIn: 2000, tokensCached: 18000, tokensOut: 300, tokensThinking: 100 }, // 2400
    { at: at(4 * 60), model: "gemini-3.8-pro", tokensIn: 1000, tokensCached: 0, tokensOut: 0, tokensThinking: null }, // 1000, oldest in 5 h
    { at: at(6 * 60), model: "gemini-3.8-flash", tokensIn: 500, tokensCached: null, tokensOut: 500, tokensThinking: 0 }, // 1000, week only
    { at: at(8 * 24 * 60), model: "gemini-3.8-flash", tokensIn: 9999, tokensCached: 0, tokensOut: 0, tokensThinking: 0 }, // outside the week
    { at: at(10), model: "claude-sonnet-4-6", tokensIn: 25000, tokensCached: null, tokensOut: 500, tokensThinking: null }, // 25500
    { at: at(10), model: "gpt-oss-120b", tokensIn: 7, tokensCached: null, tokensOut: 7, tokensThinking: null },
  ];
  const limits = { gemini5h: 10_000, geminiWeek: 4000, claude5h: null, claudeWeek: 100_000 };
  const bars = limitBars(rows, limits, now);

  it("has the four bars in order", () => {
    expect(bars.map((b) => b.key)).toEqual(["gemini5h", "geminiWeek", "claude5h", "claudeWeek"]);
  });
  it("sums new input + output + thinking in the window, per family", () => {
    expect(bars[0]).toMatchObject({ used: 3400, limit: 10_000, remaining: 6600, pct: 34, runs: 2 });
    expect(bars[1]).toMatchObject({ used: 4400, limit: 4000, remaining: 0, pct: 100, runs: 3 });
    expect(bars[2]).toMatchObject({ used: 25500, limit: null, remaining: null, pct: null });
    expect(bars[3]).toMatchObject({ used: 25500, limit: 100_000, remaining: 74500, pct: 26 });
  });
  it("resets as the oldest run leaves the window", () => {
    expect(bars[0].resetsAt).toEqual(new Date(at(4 * 60).getTime() + 5 * 3_600_000));
    expect(bars[1].resetsAt).toEqual(new Date(at(6 * 60).getTime() + 7 * 86_400_000));
    expect(limitBars([], limits, now)[0]).toMatchObject({ used: 0, resetsAt: null, pct: 0 });
  });
});
