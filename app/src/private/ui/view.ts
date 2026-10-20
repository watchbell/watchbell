import { clockSeconds, dayKey } from "@/lib/time";
import type { LogRow } from "@/private/ai/views-db";

// Pure formatting for the AI Gateway pages (no DB, safe in client components).

// The Quota ring: warn at 25 % remaining or less, error at 10 % or less (the mockup's .ring).
export function ringTone(pctLeft: number): "" | "warn" | "err" {
  return pctLeft <= 10 ? "err" : pctLeft <= 25 ? "warn" : "";
}
export const ringPct = (n: number): number => Math.min(100, Math.max(0, Math.round(n)));

export function logTone(status: number): "ok" | "warn" | "err" {
  return status < 400 ? "ok" : status === 429 ? "warn" : "err";
}

export function modelOrTool(r: Pick<LogRow, "kind" | "model" | "tool">): string {
  if (r.kind === "mcp") return `MCP · ${r.tool ?? "initialize"}`;
  return r.model ?? (r.tool ? r.tool : "—");
}

const n0 = (n: number) => n.toLocaleString("en-US");
export const fmtTokens = (i: number | null, o: number | null): string => (i === null && o === null ? "—" : `${i === null ? "—" : n0(i)} / ${o === null ? "—" : n0(o)}`);
export const fmtLatency = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
export function fmtCtx(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`.replace(".0M", "M");
  return n >= 1000 ? `${Math.round(n / 1024)}k` : String(n);
}

// "07:41:12" on the configured zone's clock (lib/time.ts; WIB by default), like every time in the console.
export const windowTime = (d: Date): string => clockSeconds(d);
export const windowDateTime = (d: Date): string => `${dayKey(d)} ${windowTime(d)}`;

export type ProviderBrief = { name: string; kind: string; enabled: boolean; isDefault: boolean; lastTestStatus: number | null };

// The Overview "Provider" tile.
export function providerTile(providers: ProviderBrief[]): { tone: "ok" | "err" | "off"; title: string; detail: string | null } {
  const on = providers.filter((p) => p.enabled);
  if (on.length === 0) return { tone: "off", title: "Not connected", detail: null };
  const main = on.find((p) => p.isDefault) ?? on[0];
  const bad = (p: ProviderBrief) => p.lastTestStatus !== null && p.lastTestStatus >= 400;
  const rest = on.filter((p) => p !== main);
  const okRest = rest.filter((p) => !bad(p));
  const parts = [
    ...(main.isDefault ? ["Default"] : []),
    ...(okRest.length ? [`${okRest.map((p) => p.name).join(", ")} also on`] : []),
    ...rest.filter(bad).map((p) => `${p.name} needs attention`),
  ];
  return { tone: bad(main) ? "err" : "ok", title: main.name, detail: parts.length ? parts.join(" · ") : null };
}

export type QuotaGroupLike = { group: string; rows: { label: string; pctLeft: number; used: number | null; limit: number | null; resetsIn: string }[] };
export type QuotaPreviewRow = { group: string; label: string; pctLeft: number; used: number | null; limit: number | null; resetsIn: string };

// Overview step "Check the quota": the first two rows, daily limits first (the ones a free tier runs out of).
export function topQuotaRows(groups: QuotaGroupLike[], n = 2): QuotaPreviewRow[] {
  const flat = groups.flatMap((g) => g.rows.map((r) => ({ group: g.group, ...r })));
  const daily = flat.filter((r) => /daily/i.test(r.label));
  return [...daily, ...flat.filter((r) => !daily.includes(r))].slice(0, n);
}

// A log row's time: the local clock with seconds for today, "10-12 23:41:12" for an earlier day.
export function logTime(d: Date, now: Date): string {
  return dayKey(d) === dayKey(now) ? windowTime(d) : `${dayKey(d).slice(5)} ${windowTime(d)}`;
}
