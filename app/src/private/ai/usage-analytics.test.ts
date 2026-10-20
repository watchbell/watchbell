import { describe, expect, it } from "vitest";
import { USAGE_COPY } from "@/lib/copy/edition";
import {
  activityLine, buildGraph, parseRange, rangeWindow, recentRow, type UsageRow, usageSeries, usageStats,
} from "./usage-analytics";

// 10:30 WIB on 13 Oct.
const now = new Date("2026-10-13T03:30:00Z");
const row = (o: Partial<UsageRow> = {}): UsageRow => ({
  at: new Date("2026-10-13T03:10:00Z"), kind: "agent", model: "gemini-3.8-flash", tool: "ask", providerId: null, agentId: "a1",
  tokensIn: 2000, tokensCached: 18000, tokensOut: 300, tokensThinking: 100, latencyMs: 4200, status: 200, ...o,
});

describe("parseRange", () => {
  it("accepts the five ranges and defaults to 24h", () => {
    for (const r of ["today", "24h", "7d", "30d", "all"]) expect(parseRange(r)).toBe(r);
    expect(parseRange(undefined)).toBe("24h");
    expect(parseRange("60d")).toBe("24h");
    expect(parseRange(["7d"])).toBe("7d");
  });
});

describe("rangeWindow: buckets", () => {
  it("today: hourly from WIB midnight up to the current hour", () => {
    const w = rangeWindow("today", now);
    expect(w.bucket).toBe("hour");
    expect(w.since.toISOString()).toBe("2026-10-12T17:00:00.000Z"); // 00:00 WIB
    expect(w.starts).toHaveLength(11); // 00 … 10 WIB
    expect(w.starts.at(-1)!.toISOString()).toBe("2026-10-13T03:00:00.000Z");
  });
  it("24h: the 24 hourly buckets ending with the current hour", () => {
    const w = rangeWindow("24h", now);
    expect(w.starts).toHaveLength(24);
    expect(w.since.toISOString()).toBe("2026-10-12T04:00:00.000Z");
  });
  it("7d / 30d: daily WIB buckets including today", () => {
    const w7 = rangeWindow("7d", now);
    expect(w7.bucket).toBe("day");
    expect(w7.starts).toHaveLength(7);
    expect(w7.since.toISOString()).toBe("2026-10-06T17:00:00.000Z");
    expect(rangeWindow("30d", now).starts).toHaveLength(30);
  });
  it("all: whatever the 30-day retention keeps, daily", () => {
    const w = rangeWindow("all", now);
    expect(w.bucket).toBe("day");
    expect(w.starts).toHaveLength(31);
    expect(w.since.toISOString()).toBe("2026-09-12T17:00:00.000Z");
  });
});

describe("usageStats", () => {
  it("counts model work only: agent, chat and console rows", () => {
    const s = usageStats([
      row(),
      row({ kind: "chat", model: "gemini/gemini-3.8-flash", providerId: "p1", tokensIn: 50, tokensCached: null, tokensOut: 10, tokensThinking: null }),
      row({ kind: "mcp", tokensIn: null, tokensOut: null }),
    ]);
    expect(s).toEqual({ requests: 2, agentRequests: 1, providerRequests: 1, input: 2050, cached: 18000, output: 410, thinking: 100, errors: 0 });
  });
  it("counts failed rows", () => {
    expect(usageStats([row({ status: 429 }), row({ status: 500 })]).errors).toBe(2);
    expect(usageStats([])).toMatchObject({ requests: 0, input: 0 });
  });
});

describe("usageSeries", () => {
  it("puts each row in its bucket: new, cached, output (incl. thinking), requests", () => {
    const w = rangeWindow("today", now);
    const s = usageSeries([row(), row({ at: new Date("2026-10-12T17:30:00Z") }), row({ at: new Date("2026-10-12T10:00:00Z") })], w);
    expect(s).toHaveLength(11);
    expect(s[0]).toMatchObject({ label: "00:00", fresh: 2000, cached: 18000, output: 400, requests: 1 });
    expect(s[10]).toMatchObject({ label: "10:00", requests: 1 });
    expect(s.slice(1, 10).every((b) => b.requests === 0)).toBe(true);
  });
  it("labels days by WIB date", () => {
    const s = usageSeries([row()], rangeWindow("7d", now));
    expect(s.at(-1)).toMatchObject({ label: "13 Oct", requests: 1 });
    expect(s[0].label).toBe("7 Oct");
  });
});

describe("recentRow", () => {
  it("shows agent runs as ag/<id> with the purpose, split tokens and status", () => {
    expect(recentRow(row(), now)).toMatchObject({
      model: "ag/gemini-3.8-flash", purpose: "ask", fresh: 2000, cached: 18000, out: 400, durationMs: 4200, tone: "ok", when: "20 min ago", whenTitle: "13 Oct 2026, 10:10 WIB",
    });
  });
  it("names provider calls by model and API calls by their tool", () => {
    expect(recentRow(row({ kind: "chat", model: "gemini/gemini-3.8-flash", tool: null, status: 502 }), now)).toMatchObject({ model: "gemini/gemini-3.8-flash", purpose: "chat", tone: "err" });
    expect(recentRow(row({ kind: "mcp", model: null, tool: "list_apps", tokensIn: null, tokensCached: null, tokensOut: null, tokensThinking: null }), now))
      .toMatchObject({ model: "list_apps", purpose: "mcp", fresh: null, cached: null, out: null });
    expect(recentRow(row({ status: 429 }), now).tone).toBe("warn");
  });
});

describe("buildGraph", () => {
  const base = {
    agModels: [{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" }, { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }],
    providers: [{ id: "p1", name: "Gemini API", kind: "gemini", enabled: true }, { id: "p2", name: "Groq", kind: "groq", enabled: false }],
    clients: [{ id: "a1", name: "antigravity", displayName: null }, { id: "a2", name: "claude-code", displayName: "Laptop" }],
    rows: [row(), row({ kind: "chat", providerId: "p1", agentId: null })],
    byAgent: new Map([["a2", 4]]),
    running: null,
  };

  it("has the hub, Antigravity with its model chips, each provider and each MCP client", () => {
    const g = buildGraph(base);
    expect(g.nodes.map((n) => [n.id, n.kind, n.label])).toEqual([
      ["hub", "hub", "Watchbell"],
      ["antigravity", "antigravity", USAGE_COPY.graphLabel],
      ["provider:p1", "provider", "Gemini API"],
      ["provider:p2", "provider", "Groq"],
      ["client:a1", "client", "antigravity"],
      ["client:a2", "client", "Laptop"],
    ]);
    expect(g.nodes[1].chips).toEqual([{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", active: true }, { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", active: false }]);
    expect(g.edges.map((e) => e.to)).toEqual(g.nodes.slice(1).map((n) => n.id));
  });

  it("an edge is active when its node had traffic in the range", () => {
    const g = buildGraph(base);
    const active = Object.fromEntries(g.edges.map((e) => [e.to, e.active]));
    expect(active).toEqual({ antigravity: true, "provider:p1": true, "provider:p2": false, "client:a1": false, "client:a2": true });
    expect(g.nodes.find((n) => n.id === "antigravity")!.requests).toBe(1);
    expect(g.edges.some((e) => e.running)).toBe(false);
  });

  it("keeps the Antigravity node but marks it not connected (owner 14 Oct)", () => {
    expect(buildGraph({ ...base, agConnected: false }).nodes.find((n) => n.id === "antigravity")?.sub).toBe("not connected");
    expect(buildGraph({ ...base, agConnected: true }).nodes.find((n) => n.id === "antigravity")?.sub).toBe(USAGE_COPY.graphSub);
  });
  it("the Antigravity edge runs while a run is in progress, even without traffic in the range", () => {
    const g = buildGraph({ ...base, rows: [], running: { model: "claude-sonnet-4-6", purpose: "ask", startedAt: now.toISOString() } });
    const e = g.edges.find((x) => x.to === "antigravity")!;
    expect(e).toMatchObject({ active: true, running: true });
    expect(g.nodes[1].chips!.find((c) => c.id === "claude-sonnet-4-6")!.active).toBe(true);
  });

  it("places the hub in the middle and every node inside the view box", () => {
    const g = buildGraph(base);
    expect(g.nodes[0]).toMatchObject({ x: g.width / 2, y: g.height / 2 });
    for (const n of g.nodes) {
      expect(n.x).toBeGreaterThan(0); expect(n.x).toBeLessThan(g.width);
      expect(n.y).toBeGreaterThan(0); expect(n.y).toBeLessThan(g.height);
    }
  });
});

describe("activityLine", () => {
  it("running: model label, purpose and elapsed seconds", () => {
    const running = { model: "claude-sonnet-4-6", purpose: "ask" as const, startedAt: "2026-10-13T03:29:18Z", questions: 2 };
    expect(activityLine(running, null, [{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }], now)).toEqual({ running: true, text: "Running now: Claude Sonnet 4.6 · ask · 42 s" });
  });
  it("idle: when the last run was, or never", () => {
    expect(activityLine(null, new Date("2026-10-13T03:10:00Z"), [], now)).toEqual({ running: false, text: "Idle · last run 20 min ago" });
    expect(activityLine(null, null, [], now)).toEqual({ running: false, text: "Idle · no runs reported yet" });
  });
});
