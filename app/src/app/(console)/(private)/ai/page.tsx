import { IconPlus } from "@tabler/icons-react";
import Link from "next/link";
import { AutoRefresh } from "@/components/live";
import { buttonClass, Card, PageHeader, Progress } from "@/components/kit";
import { Status } from "@/components/status";
import { serverEnv } from "@/lib/env";
import { clampPct } from "@/lib/status";
import { overviewCounts } from "@/private/ai/views-db";
import { CodeTabs, PromptBox } from "@/private/ui/code-tabs";
import { groupedQuota } from "@/private/ui/deps";
import { agentPrompt, quickStart } from "@/private/ui/snippets";
import { providerTile, topQuotaRows } from "@/private/ui/view";
import { NoAccess } from "@/components/no-access";
import { pageGate } from "@/lib/auth";
import { AI_COPY } from "@/lib/copy/edition";

const metric = "text-[26px] font-semibold tracking-tight";
const sub = "mt-1 text-[12.5px] text-ink-soft";
const scopeChip = "mr-1 inline-block whitespace-nowrap rounded border border-line bg-surface-2 px-[5px] font-mono text-xs text-ink-soft";

const ENDPOINTS: { m: "post" | "get"; path: string; scope: string; op: string }[] = [
  { m: "post", path: "/api/v1/ai/chat/completions", scope: "ai:invoke", op: "ai-chat" },
  { m: "get", path: "/api/v1/ai/models", scope: "ai:invoke", op: "ai-models" },
  { m: "get", path: "/api/v1/status", scope: "read:status", op: "status" },
  { m: "post", path: "/api/v1/mcp", scope: "read:status", op: "mcp" },
  { m: "get", path: "/api/v1/me", scope: "any key", op: "me" },
];

export default async function AiOverviewPage() {
  const gate = await pageGate("owner"); // R2, again here: a layout doesn't stop its page from running
  if (!gate.ok) return <NoAccess role={gate.member.role} />;
  const now = new Date();
  const origin = serverEnv().SITE_URL;
  const [counts, quota] = await Promise.all([
    overviewCounts(now),
    // The quota step is a preview: a failed read leaves it empty, the Quota page says why.
    groupedQuota(now).catch(() => []),
  ]);
  const prov = providerTile(counts.providers);
  const rows = topQuotaRows(quota);
  const t = counts.today;

  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader
        crumbs={[{ label: "AI & API" }, { label: "AI Gateway" }]}
        title="AI Gateway"
        sub={AI_COPY.overviewSub}
        actions={
          <>
            <Link href="/api-docs" className={buttonClass()}>API explorer</Link>
            <Link href="/ai/keys" className={buttonClass({ variant: "primary" })}><IconPlus size={16} aria-hidden />Create key</Link>
          </>
        }
      />

      <div className="grid grid-cols-4 gap-4 max-[1100px]:grid-cols-2 max-[600px]:grid-cols-1">
        <Card title="Provider">
          <Status state={prov.tone === "ok" ? "ok" : prov.tone === "err" ? "err" : "off"}>{prov.title}</Status>
          {prov.detail ? <p className={sub}>{prov.detail}</p> : prov.tone === "off" ? <p className={sub}><Link href="/ai/providers">Connect a provider</Link>{AI_COPY.overviewNoProvider}</p> : null}
        </Card>
        <Card title="API keys">
          <span className={metric}>{counts.keys.active}</span> <span className="text-ink-soft">active</span>
          <p className={sub}>{counts.keys.revoked} revoked · {counts.keys.neverUsed} never used</p>
        </Card>
        <Card title="Requests today">
          <span className={metric}>{t.requests.toLocaleString("en-US")}</span>
          <p className={sub}>{t.rateLimited} answered 429 · {t.refused} refused 401/403</p>
        </Card>
        <Card title="Agents seen">
          <span className={metric}>{counts.agents.active24h}</span> <span className="text-ink-soft">active 24h</span>
          <p className={sub}>{counts.agents.names.length ? <Link href="/ai/agents">{counts.agents.names.join(", ")}</Link> : <>None yet. <Link href="/ai/connect">Connect an agent</Link></>}</p>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 min-[1001px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card title="Quick start" meta="4 steps">
          <ol className="m-0 list-none p-0">
            <Step n={1} done={counts.keys.active > 0} title="Create an API key">
              <p>
                One key per app or agent, named after it, so Agents and Logs can tell them apart. Pick only the scopes it needs:{" "}
                <span className={scopeChip}>ai:invoke</span> for models, <span className={scopeChip}>read:status</span> for console data and MCP.
              </p>
              <Link href="/ai/keys" className={buttonClass({ size: "sm" })}><IconPlus size={15} aria-hidden />Create key</Link>{" "}
              <Link href="/ai/keys" className={buttonClass({ size: "sm", variant: "ghost" })}>{counts.keys.active} key{counts.keys.active === 1 ? "" : "s"}</Link>
            </Step>
            <Step n={2} title="Check the quota">
              <p>Each provider has its own free limits. Your key&apos;s own limit (requests per minute) applies first.</p>
              {rows.length === 0 ? (
                <p className="text-ink-faint">No usage numbers yet. They appear after the first call through Watchbell.</p>
              ) : rows.map((r) => {
                const used = 100 - r.pctLeft;
                return (
                  <div key={`${r.group}-${r.label}`} className="mb-2">
                    <div className="flex items-center justify-between gap-3 text-[13px]">
                      <span className="font-mono">{r.group} · {r.label}</span>
                      <span className="font-mono text-ink-soft">{r.pctLeft} % left</span>
                    </div>
                    <Progress pct={clampPct(used)} tone={r.pctLeft <= 10 ? "err" : r.pctLeft <= 25 ? "warn" : undefined} />
                  </div>
                );
              })}
              <Link href="/ai/quota" className={buttonClass({ size: "sm", variant: "ghost" })}>Open quota</Link>
            </Step>
            <Step n={3} title="Export the key">
              <p>Keep it in an environment variable or your host&apos;s secret store, never in code.</p>
              <CodeTabs label="Export the key" tabs={[["bash", 'export WATCHBELL_API_KEY="wb_..."'], ["PowerShell", '$env:WATCHBELL_API_KEY = "wb_..."'], ["Vercel", "vercel env add WATCHBELL_API_KEY production"]]} />
            </Step>
            <Step n={4} title="Make your first request">
              <p>OpenAI-compatible: any OpenAI client works with Watchbell&apos;s base URL. Within a minute of the first call the client shows up under Agents.</p>
              <CodeTabs label="First request" tabs={quickStart(origin)} />
            </Step>
          </ol>
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          <Card title="Prompt for your coding agent">
            <p className="mb-2 text-[13px] text-ink-soft">{AI_COPY.promptHint}</p>
            <PromptBox text={agentPrompt(origin)} />
          </Card>
          <Card title="Endpoints" meta={<Link href="/api-docs">API explorer</Link>}>
            {ENDPOINTS.map((e) => (
              <div key={e.path} className="flex items-center gap-2 border-b border-line py-2 last:border-b-0">
                <span className="min-w-0 flex-1">
                  <span className={`mr-1.5 inline-block min-w-[46px] rounded px-[5px] text-center font-mono text-[11px] font-medium ${e.m === "get" ? "bg-teal-soft text-teal" : "bg-brand-soft text-brand"}`}>{e.m.toUpperCase()}</span>
                  <Link href={`/api-docs/${e.op}`} className="font-mono text-[12.5px]">{e.path}</Link>
                </span>
                <span className={scopeChip}>{e.scope}</span>
              </div>
            ))}
          </Card>
          <Card title="Connect an agent">
            <p className="mb-2 text-[13px] text-ink-soft">{AI_COPY.connectHint}</p>
            <Link href="/ai/connect" className={buttonClass({ size: "sm" })}>Open Connect an agent</Link>
          </Card>
          <Card title="Privacy">
            <p className="m-0 text-[13px] text-ink-soft">
              Free tiers may use prompts to improve the provider&apos;s models (Gemini&apos;s free tier does). The gateway forwards only what the caller sends. The console&apos;s own AI
              features send summaries with names aliased, never URLs, emails, keys or connection strings. Prompts aren&apos;t stored here.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[26px_minmax(0,1fr)] gap-3 border-b border-line py-3.5 first:pt-0 last:border-b-0 last:pb-0">
      <span className={`grid size-6 place-items-center rounded-full border font-mono text-xs ${done ? "border-transparent bg-ok-soft text-ok" : "border-line-strong text-ink-soft"}`}>{n}</span>
      <div className="min-w-0 [&>p]:mb-2 [&>p]:text-[13px] [&>p]:text-ink-soft">
        <h3 className="mb-1 mt-0.5 text-[14px] font-medium">{title}</h3>
        {children}
      </div>
    </li>
  );
}
