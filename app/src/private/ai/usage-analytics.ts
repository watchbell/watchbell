import { USAGE_COPY } from "@/lib/copy/edition";
import type { AgRunning } from "./agent-usage";
import { agoShort } from "./time-text";

// AI › Usage & Analytics (owner 13 Oct). Pure maths over ai_usage rows: the range and its buckets (WIB), the stat
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
const WIB = 7 * H; // Asia/Jakarta, no daylight saving
const hourStart = (t: number) => Math.floor(t / H) * H;
export const wibDayStart = (t: number) => Math.floor((t + WIB) / D) * D - WIB;

export type Window = { range: Range; since: Date; bucket: "hour" | "day"; starts: Date[] };

// Buckets oldest first; `since` is the first bucket's start, so the cards and the chart cover the same rows.
export function rangeWindow(range: Range, now: Date): Window {
  const t = now.getTime();
  const span = (first: number, last: number, step: number) => {
    const out: Date[] = [];
    for (let x = first; x <= last; x += step) out.push(new Date(x));
    return out;
  };
  if (range === "today" || range === "24h") {
    const last = hourStart(t);
    const first = range === "today" ? wibDayStart(t) : last - 23 * H;
    return { range, since: new Date(first), bucket: "hour", starts: span(first, last, H) };
  }
  const today = wibDayStart(t);
  const first = range === "7d" ? today - 6 * D : range === "30d" ? today - 29 * D : wibDayStart(t - RETENTION_DAYS * D);
  return { range, since: new Date(first), bucket: "day", starts: span(first, today, D) };
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

const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", ...o });
const hh = fmt({ hour: "2-digit", minute: "2-digit", hour12: false });
const dayMonth = fmt({ day: "numeric", month: "short" });
const year = fmt({ year: "numeric" });

export type SeriesPoint = { t: Date; label: string; fresh: number; cached: number; output: number; requests: number };

export function usageSeries(rows: UsageRow[], w: Window): SeriesPoint[] {
  const pts: SeriesPoint[] = w.starts.map((t) => ({ t, label: w.bucket === "hour" ? hh.format(t) : dayMonth.format(t), fresh: 0, cached: 0, output: 0, requests: 0 }));
  const first = w.starts[0]?.getTime() ?? 0;
  const step = w.bucket === "hour" ? H : D;
  for (const r of rows) {
    if (!isModelWork(r)) continue;
    const i = Math.floor((r.at.getTime() - first) / step);
    if (i < 0 || i >= pts.length) continue;
    const p = pts[i];
    p.requests++;
    p.fresh += n(r.tokensIn);
    p.cached += n(r.tokensCached);
    p.output += n(r.tokensOut) + n(r.tokensThinking);
  }
  return pts;
}

// "13 Oct 2026, 10:10 WIB"
export const wibStamp = (d: Date): string => `${dayMonth.format(d)} ${year.format(d)}, ${hh.format(d)} WIB`;

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
    when: agoShort(r.at, now), whenTitle: wibStamp(r.at),
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
