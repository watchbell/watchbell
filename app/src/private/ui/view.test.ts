import { afterEach, describe, expect, it } from "vitest";
import { resetTimeZoneForTests } from "@/lib/time";
import type { LogRow } from "@/private/ai/views-db";
import { csvCell, logCsvHeader, logsToCsv } from "./csv";
import { LIMITS } from "./limits";
import { fmtCtx, fmtLatency, fmtTokens, logTone, modelOrTool, providerTile, ringPct, ringTone, windowTime } from "./view";

const row = (o: Partial<LogRow> = {}): LogRow => ({
  id: 1, at: new Date("2026-10-13T00:41:12Z"), keyName: "laptop-agents", client: "gemini-cli/0.9.0", model: null, kind: "mcp", tool: "get_app",
  tokensIn: null, tokensOut: null, latencyMs: 180, status: 200, errorClass: null, stream: false, ...o,
});

describe("ring", () => {
  it("warns at 25 % or less and errors at 10 % or less", () => {
    expect([100, 60, 26].map(ringTone)).toEqual(["", "", ""]);
    expect([25, 11].map(ringTone)).toEqual(["warn", "warn"]);
    expect([10, 0].map(ringTone)).toEqual(["err", "err"]);
  });
  it("clamps the percentage", () => {
    expect([ringPct(-4), ringPct(140), ringPct(33.6)]).toEqual([0, 100, 34]);
  });
});

describe("log formatting", () => {
  it("tones by status", () => {
    expect([200, 204, 429, 403, 502].map(logTone)).toEqual(["ok", "ok", "warn", "err", "err"]);
  });
  it("shows MCP tools and models", () => {
    expect(modelOrTool(row())).toBe("MCP · get_app");
    expect(modelOrTool(row({ tool: null }))).toBe("MCP · initialize");
    expect(modelOrTool(row({ kind: "chat", model: "gemini/gemini-3.8-flash", tool: null }))).toBe("gemini/gemini-3.8-flash");
    expect(modelOrTool(row({ kind: "me", model: null, tool: null }))).toBe("—");
  });
  it("formats tokens, latency, context sizes and the WIB time", () => {
    expect(fmtTokens(6210, 902)).toBe("6,210 / 902");
    expect(fmtTokens(null, null)).toBe("—");
    expect(fmtLatency(95)).toBe("95 ms");
    expect(fmtLatency(1640)).toBe("1.6 s");
    expect([fmtCtx(null), fmtCtx(8192), fmtCtx(131072), fmtCtx(1_000_000)]).toEqual(["—", "8k", "128k", "1M"]);
    expect(windowTime(new Date("2026-10-13T00:41:12Z"))).toBe("07:41:12");
  });
});

describe("providerTile", () => {
  it("no connection: not connected", () => {
    expect(providerTile([])).toEqual({ tone: "off", title: "Not connected", detail: null });
  });
  it("names the default and the rest", () => {
    const t = providerTile([
      { name: "Google Gemini", kind: "gemini", enabled: true, isDefault: true, lastTestStatus: 200 },
      { name: "Custom", kind: "custom", enabled: true, isDefault: false, lastTestStatus: 403 },
    ]);
    expect(t.title).toBe("Google Gemini");
    expect(t.tone).toBe("ok");
    expect(t.detail).toBe("Default · Custom needs attention");
  });
  it("a default that failed its test is an error", () => {
    expect(providerTile([{ name: "Google Gemini", kind: "gemini", enabled: true, isDefault: true, lastTestStatus: 403 }]).tone).toBe("err");
  });
  it("only disabled connections count as not connected", () => {
    expect(providerTile([{ name: "Google Gemini", kind: "gemini", enabled: false, isDefault: true, lastTestStatus: 200 }]).tone).toBe("off");
  });
});

describe("csv", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(null)).toBe("");
  });
  it("neutralises spreadsheet formulas", () => {
    for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) expect(csvCell(bad).replace(/^"/, "")).toMatch(/^'/);
  });
  it("has the same columns as the table, one line per row, metadata only", () => {
    const csv = logsToCsv([row(), row({ id: 2, kind: "chat", model: "gemini/gemini-3.8-flash", tool: null, tokensIn: 412, tokensOut: 188, latencyMs: 1100, stream: true, status: 429, errorClass: "key_rate_limit" })]);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe(logCsvHeader().join(","));
    expect(logCsvHeader()).toEqual(["Time (WIB)", "Key", "Client", "Model / tool", "Tokens in", "Tokens out", "Latency ms", "Status", "Stream", "Error class"]);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("2026-10-13 07:41:12,laptop-agents,gemini-cli/0.9.0,MCP · get_app,,,180,200,no,");
    expect(lines[2]).toBe("2026-10-13 07:41:12,laptop-agents,gemini-cli/0.9.0,gemini/gemini-3.8-flash,412,188,1100,429,yes,key_rate_limit");
  });
});

describe("limits", () => {
  it("the Playground is 30 requests per 10 minutes", () => {
    expect(LIMITS.playground).toEqual({ name: "playground", max: 30, windowSeconds: 600 });
  });
});

import { topQuotaRows } from "./view";
describe("topQuotaRows", () => {
  const g = [
    { group: "Gemini · all models", rows: [
      { label: "Per-minute request limit (you entered)", pctLeft: 90, used: 2, limit: 20, resetsIn: "41s" },
      { label: "Daily request limit (you entered)", pctLeft: 60, used: 40, limit: 100, resetsIn: "9h 12m" },
    ] },
    { group: "Gemini · gemini-3.8-flash", rows: [{ label: "Daily token limit", pctLeft: 5, used: 95, limit: 100, resetsIn: "2h 05m" }, { label: "Weekly token limit", pctLeft: 50, used: 1, limit: 2, resetsIn: "4d 6h" }] },
  ];
  it("prefers daily rows, then fills with the rest, at most n", () => {
    expect(topQuotaRows(g).map((r) => r.label)).toEqual(["Daily request limit (you entered)", "Daily token limit"]);
    expect(topQuotaRows(g, 3).map((r) => r.label)).toEqual(["Daily request limit (you entered)", "Daily token limit", "Per-minute request limit (you entered)"]);
    expect(topQuotaRows([])).toEqual([]);
  });
});

import { logTime } from "./view";
describe("logTime", () => {
  it("clock for today, month-day for earlier", () => {
    const now = new Date("2026-10-13T05:00:00Z");
    expect(logTime(new Date("2026-10-13T00:41:12Z"), now)).toBe("07:41:12");
    expect(logTime(new Date("2026-10-12T16:41:12Z"), now)).toBe("10-12 23:41:12");
  });
});

describe("csv and log times in the configured zone (1.1)", () => {
  afterEach(() => resetTimeZoneForTests());
  it("names the zone in the header and writes local times", () => {
    resetTimeZoneForTests("Asia/Kolkata");
    expect(logCsvHeader()[0]).toBe("Time (Asia/Kolkata)");
    const lines = logsToCsv([row()]).trim().split("\r\n");
    expect(lines[0].startsWith("Time (Asia/Kolkata),Key,")).toBe(true);
    expect(lines[1].startsWith("2026-10-13 06:11:12,")).toBe(true);
    expect(windowTime(new Date("2026-10-13T00:41:12Z"))).toBe("06:11:12");
  });
});
