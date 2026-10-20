import { IconActivity, IconPlayerPause } from "@tabler/icons-react";
import Link from "next/link";
import { StackedBars } from "@/components/charts";
import { Card, EmptyState, PageHeader, Progress } from "@/components/kit";
import { AutoRefresh } from "@/components/live";
import { NoAccess } from "@/components/no-access";
import { pageGate } from "@/lib/auth";
import { USAGE_COPY } from "@/lib/copy/edition";
import { cn } from "@/lib/utils";
import { type AgActivity, type AgLimits, EMPTY_LIMITS, limitBars } from "@/private/ai/agent-usage";
import {
  agentWeekRows, mcpClients, modelRowsSince, providerList, readUsageSettings, recentRows, requestsByAgent,
} from "@/private/ai/agent-usage-db";
import { enabledModels, isFresh, readAgSettings, readRouterQuota } from "@/private/ai/extras";
import { RouterQuotaCard } from "@/private/ai/extras-ui";
import { durationText, wibTime } from "@/private/ai/time-text";
import {
  activityLine, API_KINDS, buildGraph, MODEL_KINDS, parseRange, RANGES, rangeWindow, recentRow, usageSeries, usageStats,
} from "@/private/ai/usage-analytics";
import { LimitsForm } from "./limits-form";
import { UsageGraph } from "./usage-graph";

type SearchParams = Record<string, string | string[] | undefined>;

const nf = new Intl.NumberFormat("en");
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const metric = "font-mono text-[24px] font-semibold tracking-tight";
const label = "text-[11.5px] font-medium uppercase tracking-wide text-ink-soft";
const subLine = "mt-1 text-[12px] text-ink-soft";
const th = "px-3 py-2 text-left text-[12px] font-medium text-ink-soft";
const cell = "border-t border-line px-3 py-2";
// While Antigravity runs, refresh every 5 s so the card and the graph follow it; otherwise the normal 60 s.
const RUNNING_MS = 5_000;

export default async function UsagePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const gate = await pageGate("owner"); // R2, again here: a layout doesn't stop its page from running
  if (!gate.ok) return <NoAccess role={gate.member.role} />;
  const sp = await searchParams;
  const range = parseRange(sp.range);
  const withApi = sp.api === "1";
  const now = new Date();
  const w = rangeWindow(range, now);

  const [{ rows, capped }, recent, week, byAgent, providers, clients, settings, ag, router] = await Promise.all([
    modelRowsSince(w.since),
    recentRows(withApi ? [...MODEL_KINDS, ...API_KINDS] : [...MODEL_KINDS], 50),
    agentWeekRows(now),
    requestsByAgent(w.since),
    providerList(),
    mcpClients(now),
    readUsageSettings(now).catch((): { activity: AgActivity | null; limits: AgLimits } => ({ activity: null, limits: { ...EMPTY_LIMITS } })),
    readAgSettings(now).catch(() => null),
    readRouterQuota().catch(() => null),
  ]);

  const agModels = ag?.report ? ag.report.models.filter((m) => enabledModels(ag.report, ag.prefs, ag.allowed).includes(m.id)) : [];
  const running = settings.activity?.running ?? null;
  const stats = usageStats(rows);
  const series = usageSeries(rows, w);
  const agConnected = !!ag?.report && isFresh(ag.report, now);
  const graph = buildGraph({ agModels, providers, clients, rows, byAgent, running, agConnected });
  const lastRun = week.reduce<Date | null>((m, r) => (!m || r.at > m ? r.at : m), null);
  const live = activityLine(running, lastRun, ag?.report?.models ?? [], now);
  const bars = limitBars(week, settings.limits, now);
  const chart = sp.chart === "requests" ? "requests" : "tokens";
  const href = (o: { range?: string; api?: boolean; chart?: string }) => {
    const q = new URLSearchParams();
    q.set("range", o.range ?? range);
    if (o.api ?? withApi) q.set("api", "1");
    if ((o.chart ?? chart) === "requests") q.set("chart", "requests");
    return `/ai/usage?${q.toString()}`;
  };
  const tab = (active: boolean) => cn("rounded-md px-2.5 py-1 text-[13px] hover:no-underline", active ? "bg-nav-active font-medium text-nav-active-text" : "text-ink-soft hover:bg-hover hover:text-ink");

  return (
    <>
      <AutoRefresh at={now.getTime()} everyMs={live.running ? RUNNING_MS : undefined} />
      <PageHeader
        crumbs={[{ label: "AI & API" }, { label: "AI Gateway", href: "/ai" }, { label: "Usage" }]}
        title="Usage & Analytics"
        sub={USAGE_COPY.sub}
      />

      <nav aria-label="Range" className="flex flex-wrap items-center gap-1">
        {RANGES.map((r) => (
          <Link key={r.key} href={href({ range: r.key })} aria-current={r.key === range ? "page" : undefined} className={tab(r.key === range)}>{r.label}</Link>
        ))}
        {range === "all" && <span className="ml-2 text-[12px] text-ink-faint">Watchbell keeps 30 days.</span>}
      </nav>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Card><div className={label}>Total requests</div><div className={metric}>{nf.format(stats.requests)}</div><div className={subLine}>{nf.format(stats.agentRequests)} {USAGE_COPY.agentRequests} · {nf.format(stats.providerRequests)} providers{stats.errors ? ` · ${stats.errors} failed` : ""}</div></Card>
        <Card><div className={label}>Input tokens</div><div className={metric} title={nf.format(stats.input)}>{compact.format(stats.input)}</div><div className={subLine}>New input, not from cache</div></Card>
        <Card><div className={label}>Cached tokens</div><div className={metric} title={nf.format(stats.cached)}>{compact.format(stats.cached)}</div><div className={subLine}>Read from the prompt cache</div></Card>
        <Card><div className={label}>Output tokens</div><div className={metric} title={nf.format(stats.output)}>{compact.format(stats.output)}</div><div className={subLine}>incl. <span className="font-mono">{compact.format(stats.thinking)}</span> thinking</div></Card>
        <Card>
          <div className={label}>Est. cost</div>
          <div className={metric}>$0.00</div>
          <div className={subLine}>{USAGE_COPY.costAgents} · providers: <span title="No prices are known for your own keys">—</span></div>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-3">
          <Card title="Sources" meta={<span className="font-mono">{RANGES.find((r) => r.key === range)?.label}</span>}>
            <div className={cn("mb-2 flex items-center gap-2 rounded-md border px-3 py-2 text-[13px]", live.running ? "border-brand bg-brand-soft text-ink" : "border-line text-ink-soft")} role="status">
              {live.running ? <IconActivity size={16} className="text-brand" aria-hidden /> : <IconPlayerPause size={16} aria-hidden />}
              <span className="font-mono text-[12.5px]">{live.text}</span>
            </div>
            <UsageGraph graph={graph} />
          </Card>

          <Card
            title={chart === "tokens" ? "Tokens" : "Requests"}
            meta={(
              <span className="flex gap-1">
                <Link href={href({ chart: "tokens" })} className={tab(chart === "tokens")}>Tokens</Link>
                <Link href={href({ chart: "requests" })} className={tab(chart === "requests")}>Requests</Link>
              </span>
            )}
          >
            <StackedBars
              height={140}
              label={chart === "tokens" ? `Tokens per ${w.bucket}: new input, cached, output` : `Requests per ${w.bucket}`}
              parts={chart === "tokens" ? ["New input", "Cached", "Output"] : ["Requests"]}
              bars={series.map((p) => ({
                key: p.t.toISOString(),
                title: chart === "tokens"
                  ? `${p.label}: ${nf.format(p.fresh)} new · ${nf.format(p.cached)} cached · ${nf.format(p.output)} out`
                  : `${p.label}: ${nf.format(p.requests)} requests`,
                values: chart === "tokens" ? [p.fresh, p.cached, p.output] : [p.requests],
              }))}
            />
            <div className="mt-1 flex justify-between font-mono text-[11px] text-ink-faint">
              <span>{series[0]?.label}</span><span>{series.at(-1)?.label}</span>
            </div>
            {capped && <p className="m-0 mt-2 text-[12px] text-warn">Only the newest 20,000 requests are counted in this range.</p>}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <RouterQuotaCard report={router} now={now} />
          {/* The old estimate only while Antigravity itself is connected. */}
          {agConnected && (
          <Card title={USAGE_COPY.quotaTitle} meta={<LimitsForm values={settings.limits} />}>
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {bars.map((b) => (
                <li key={b.key}>
                  <div className="flex items-baseline gap-2 text-[13px]">
                    <span className="font-medium">{b.label}</span>
                    <span className="ml-auto font-mono text-[12px] text-ink-soft">
                      {b.limit === null ? `${compact.format(b.used)} used` : `${compact.format(b.remaining ?? 0)} left of ${compact.format(b.limit)}`}
                    </span>
                  </div>
                  {b.limit !== null && b.pct !== null && <Progress pct={b.pct} tone={b.pct >= 100 ? "err" : b.pct >= 80 ? "warn" : undefined} />}
                  <div className="mt-1 text-[12px] text-ink-faint">
                    {b.limit === null ? "No limit entered · " : ""}
                    {b.runs} runs in {b.window}
                    {b.resetsAt ? ` · resets as the oldest run leaves the window (~${wibTime(b.resetsAt, now)})` : ""}
                  </div>
                </li>
              ))}
            </ul>
            <p className="m-0 mt-3 text-[12px] text-ink-faint">
              {USAGE_COPY.quotaNote}{" "}
              Counted: new input + output + thinking; cached input excluded.
            </p>
          </Card>
          )}
        </div>
      </div>

      <Card
        title="Recent requests"
        meta={(
          <Link href={href({ api: !withApi })} className="text-[12.5px]" aria-pressed={withApi}>
            {withApi ? "Hide API calls" : "Include API calls"}
          </Link>
        )}
        flush
      >
        {recent.length === 0 ? (
          <EmptyState title="No requests yet">{USAGE_COPY.emptyRecent}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={th}>Model</th>
                  <th className={th}>Purpose</th>
                  <th className={`${th} text-right`}>New ↑</th>
                  <th className={`${th} text-right`}>Cached</th>
                  <th className={`${th} text-right`}>Out ↓</th>
                  <th className={`${th} text-right`}>Duration</th>
                  <th className={th}>Status</th>
                  <th className={th}>When</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r, i) => recentRow(r, now, i)).map((r) => (
                  <tr key={r.key}>
                    <td className={`${cell} max-w-[260px] truncate font-mono text-[12.5px]`}>{r.model}</td>
                    <td className={`${cell} text-ink-soft`}>{r.purpose}</td>
                    <td className={`${cell} text-right font-mono`}>{r.fresh === null ? "–" : nf.format(r.fresh)}</td>
                    <td className={`${cell} text-right font-mono`}>{r.cached === null ? "–" : nf.format(r.cached)}</td>
                    <td className={`${cell} text-right font-mono`}>{r.out === null ? "–" : nf.format(r.out)}</td>
                    <td className={`${cell} text-right font-mono`}>{r.durationMs < 1000 ? `${r.durationMs} ms` : durationText(r.durationMs)}</td>
                    <td className={cell}>
                      <span className="inline-flex items-center gap-1.5 font-mono text-[12px]">
                        <i className={cn("inline-block size-2 rounded-full", r.tone === "ok" ? "bg-ok" : r.tone === "warn" ? "bg-warn-icon" : "bg-err")} aria-hidden />
                        {r.status}
                      </span>
                    </td>
                    <td className={`${cell} whitespace-nowrap text-ink-soft`} title={r.whenTitle}>{r.when}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
