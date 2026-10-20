import { USAGE_COPY } from "@/lib/copy/edition";
import { dayKey, dayStart, zonedFormat, zonedParts, zoneLabel } from "@/lib/time";
import { dayKeys } from "@/lib/view/uptime";
import type { AgRunning } from "./agent-usage";
import { agoShort } from "./time-text";

// AI › Usage & Analytics (owner 13 Oct). Pure maths over ai_usage rows: the range and its buckets (local time), the stat
// cards, the Tokens/Requests chart, the recent-requests rows and the provider graph. No DB, no "server-only".

export const RANGES = [
  { key: "today", label: "Today" },
  { key: "24h", label: "24 h" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "all", label: "All" },
] as const;
export type Range = (typeof RANGES)[number]["key"];
export const DEFAULT_RANGE: Range = "24h";
export const MODEL_KINDS = ["agent", "chat", "console"] as const; // real model work
export const API_KINDS = ["mcp", "status", "me"] as const; // REST/MCP plumbing, only with "Include API calls"
export const RETENTION_DAYS = 30;

export function parseRange(raw: unknown): Range {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return RANGES.some((r) => r.key === v) ? (v as Range) : DEFAULT_RANGE;
}

const H = 3_600_000;
const D = 86_400_000;
const MINUTE = 60_000;
// The start of the local hour t is in: a whole UTC hour in WIB, :30 past one in Asia/Kolkata.
const hourStart = (t: number) => Math.floor(t / MINUTE) * MINUTE - zonedParts(new Date(t)).minute * MINUTE;
// Local midnight of the day t is in (lib/time.ts; a day can be 23 or 25 hours long).
export const localDayStart = (t: number) => dayStart(dayKey(new Date(t))).getTime();

export type Window = { range: Range; since: Date; bucket: "hour" | "day"; starts: Date[] };

// Buckets oldest first; `since` is the first bucket's start, so the cards and the chart cover the same rows. Hour
// buckets are an hour apart; day buckets start at local midnight.
export function rangeWindow(range: Range, now: Date): Window {
  const t = now.getTime();
  if (range === "today" || range === "24h") {
    const last = hourStart(t);
    const first = range === "today" ? localDayStart(t) : last - 23 * H;
    const starts: Date[] = [];
    for (let x = first; x <= last; x += H) starts.push(new Date(x));
    return { range, since: new Date(first), bucket: "hour", starts };
  }
  const days = range === "7d" ? 7 : range === "30d" ? 30 : Math.round((localDayStart(t) - localDayStart(t - RETENTION_DAYS * D)) / D) + 1;
  const starts = dayKeys(now, days).map(dayStart);
  return { range, since: starts[0], bucket: "day", starts };
}

export type UsageRow = {
  at: Date; kind: string; model: string | null; tool: string | null; providerId: string | null; agentId: string | null;
  tokensIn: number | null; tokensCached: number | null; tokensOut: number | null; tokensThinking: number | null; latencyMs: number; status: number;
};

const isModelWork = (r: UsageRow) => (MODEL_KINDS as readonly string[]).includes(r.kind);
const n = (v: number | null) => v ?? 0;

export type UsageStats = {
  requests: number; agentRequests: number; providerRequests: number; input: number; cached: number; output: number; thinking: number; errors: number;
};

// Output includes thinking (thinking is also given on its own for the sub-line).
export function usageStats(rows: UsageRow[]): UsageStats {
  const s: UsageStats = { requests: 0, agentRequests: 0, providerRequests: 0, input: 0, cached: 0, output: 0, thinking: 0, errors: 0 };
  for (const r of rows) {
    if (!isModelWork(r)) continue;
    s.requests++;
    if (r.kind === "agent") s.agentRequests++;
    else s.providerRequests++;
    s.input += n(r.tokensIn);
    s.cached += n(r.tokensCached);
    s.output += n(r.tokensOut) + n(r.tokensThinking);
    s.thinking += n(r.tokensThinking);
    if (r.status >= 400) s.errors++;
  }
  return s;
}

// In the configured zone (lib/time.ts), read when called: the zone is known by then, also in tests.
const fmt = (o: Intl.DateTimeFormatOptions) => zonedFormat("en-GB", o);
const hh = (d: Date) => fmt({ hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
const dayMonth = (d: Date) => fmt({ day: "numeric", month: "short" }).format(d);
const year = (d: Date) => fmt({ year: "numeric" }).format(d);

export type SeriesPoint = { t: Date; label: string; fresh: number; cached: number; output: number; requests: number };

export function usageSeries(rows: UsageRow[], w: Window): SeriesPoint[] {
  const pts: SeriesPoint[] = w.starts.map((t) => ({ t, label: w.bucket === "hour" ? hh(t) : dayMonth(t), fresh: 0, cached: 0, output: 0, requests: 0 }));
  const first = w.starts[0]?.getTime() ?? 0;
  // Hour buckets are an hour apart; a day bucket is found by its local day (23 or 25 hours on a daylight-saving day).
  const dayIndex = new Map(w.bucket === "day" ? w.starts.map((t, i) => [dayKey(t), i] as const) : []);
  for (const r of rows) {
    if (!isModelWork(r)) continue;
    const i = w.bucket === "hour" ? Math.floor((r.at.getTime() - first) / H) : dayIndex.get(dayKey(r.at)) ?? -1;
    if (i < 0 || i >= pts.length) continue;
    const p = pts[i];
    p.requests++;
    p.fresh += n(r.tokensIn);
    p.cached += n(r.tokensCached);
    p.output += n(r.tokensOut) + n(r.tokensThinking);
  }
  return pts;
}

// "13 Oct 2026, 10:10 WIB" (the zone's label, lib/time.ts)
export const localStamp = (d: Date): string => `${dayMonth(d)} ${year(d)}, ${hh(d)} ${zoneLabel(d)}`;

export type RecentRow = {
  key: string; model: string; purpose: string; fresh: number | null; cached: number | null; out: number | null; durationMs: number;
  tone: "ok" | "warn" | "err"; status: number; when: string; whenTitle: string;
};

export function recentRow(r: UsageRow, now: Date, i = 0): RecentRow {
  const model = r.kind === "agent" ? `ag/${r.model ?? "?"}` : (r.model ?? r.tool ?? r.kind);
  const purpose = r.kind === "agent" ? (r.tool ?? "run") : r.kind;
  const hasTokens = r.tokensIn !== null || r.tokensOut !== null || r.tokensCached !== null || r.tokensThinking !== null;
  return {
    key: `${r.at.getTime()}-${i}`, model, purpose,
    fresh: hasTokens ? n(r.tokensIn) : null, cached: hasTokens ? n(r.tokensCached) : null, out: hasTokens ? n(r.tokensOut) + n(r.tokensThinking) : null,
    durationMs: r.latencyMs, status: r.status, tone: r.status === 429 ? "warn" : r.status >= 400 ? "err" : "ok",
    when: agoShort(r.at, now), whenTitle: localStamp(r.at),
  };
}

// ---- The provider graph: Watchbell in the middle, a line to each source ----

export type GraphChip = { id: string; label: string; active: boolean };
export type GraphNode = {
  id: string; kind: "hub" | "antigravity" | "provider" | "client"; label: string; sub: string; requests: number; x: number; y: number; chips?: GraphChip[];
};
export type GraphEdge = { to: string; active: boolean; running: boolean };
export type Graph = { width: number; height: number; nodes: GraphNode[]; edges: GraphEdge[] };
export type GraphInput = { agConnected?: boolean;
  agModels: { id: string; label: string }[];
  providers: { id: string; name: string; kind: string; enabled: boolean }[];
  clients: { id: string; name: string; displayName: string | null }[];
  rows: UsageRow[]; // model work in the range
  byAgent: Map<string, number>; // requests per ai_agents id in the range (any kind)
  running: AgRunning | null;
};

const GRAPH_W = 720;
const GRAPH_H = 360;

export function buildGraph(input: GraphInput): Graph {
  const agentRows = input.rows.filter((r) => r.kind === "agent");
  const used = new Set(agentRows.map((r) => r.model));
  if (input.running) used.add(input.running.model);
  const others: Omit<GraphNode, "x" | "y">[] = [
    {
      // Owner 14 Oct: history stays, but a disconnected Antigravity (no fresh report from an active key) says so.
      id: "antigravity", kind: "antigravity", label: USAGE_COPY.graphLabel, sub: input.agConnected === false ? "not connected" : USAGE_COPY.graphSub, requests: agentRows.length,
      chips: input.agModels.map((m) => ({ id: m.id, label: m.label, active: used.has(m.id) })),
    },
    ...input.providers.map((p) => ({
      id: `provider:${p.id}`, kind: "provider" as const, label: p.name, sub: p.enabled ? p.kind : `${p.kind} · off`,
      requests: input.rows.filter((r) => r.providerId === p.id).length,
    })),
    ...input.clients.map((c) => ({
      id: `client:${c.id}`, kind: "client" as const, label: c.displayName ?? c.name, sub: "MCP client", requests: input.byAgent.get(c.id) ?? 0,
    })),
  ];
  const cx = GRAPH_W / 2;
  const cy = GRAPH_H / 2;
  // Antigravity on the left; the rest around an ellipse, clockwise.
  const placed: GraphNode[] = others.map((o, i) => {
    const a = Math.PI + (2 * Math.PI * i) / Math.max(others.length, 1);
    return { ...o, x: Math.round(cx + (GRAPH_W / 2 - 110) * Math.cos(a)), y: Math.round(cy + (GRAPH_H / 2 - 50) * Math.sin(a)) };
  });
  const hub: GraphNode = { id: "hub", kind: "hub", label: "Watchbell", sub: "AI gateway", requests: input.rows.length, x: cx, y: cy };
  const edges: GraphEdge[] = placed.map((p) => {
    const running = p.id === "antigravity" && input.running !== null;
    return { to: p.id, active: p.requests > 0 || running, running };
  });
  return { width: GRAPH_W, height: GRAPH_H, nodes: [hub, ...placed], edges };
}

// The "Running now" / "Idle" card.
export function activityLine(running: AgRunning | null, lastRun: Date | null, models: { id: string; label: string }[], now: Date): { running: boolean; text: string } {
  if (running) {
    const label = models.find((m) => m.id === running.model)?.label ?? `ag/${running.model}`;
    const s = Math.max(0, Math.round((now.getTime() - Date.parse(running.startedAt)) / 1000));
    return { running: true, text: `Running now: ${label} · ${running.purpose} · ${s} s` };
  }
  return { running: false, text: lastRun ? `Idle · last run ${agoShort(lastRun, now)}` : "Idle · no runs reported yet" };
}
