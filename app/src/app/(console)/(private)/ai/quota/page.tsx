import { IconBolt, IconBrandGoogle, IconPlug } from "@tabler/icons-react";
import Link from "next/link";
import { AutoRefresh } from "@/components/live";
import { buttonClass, Card, EmptyState, PageHeader, Progress, Tag } from "@/components/kit";
import { TableHead, td, tableClass } from "@/components/table";
import { clampPct } from "@/lib/status";
import { providerList, providerUsageRows } from "@/private/ai/agent-usage-db";
import { AntigravityQuotaCard, antigravityQuota, QUOTA_PAGE_TEXT, RouterQuotaSection, routerQuotaView } from "@/private/ai/extras-ui";
import { compactNumber, type ProviderUsage, providerUsage, type UsageTotals } from "@/private/ai/provider-usage";
import { keyUsage, limitProviders } from "@/private/ai/views-db";
import { groupedQuota } from "@/private/ui/deps";
import { LimitsForm } from "./limits-form";
import { NoAccess } from "@/components/no-access";
import { pageGate } from "@/lib/auth";
import { zoneName } from "@/lib/time";

const sourceText = (r: { source: "header" | "own"; used: number | null; limit: number | null }) =>
  r.source === "header" ? "from the provider's headers" : `Watchbell's count of ${(r.used ?? 0).toLocaleString("en-US")} / ${(r.limit ?? 0).toLocaleString("en-US")}`;

async function providerSection(now: Date): Promise<ProviderUsage[]> {
  try {
    const [rows, providers] = await Promise.all([providerUsageRows(now), providerList()]);
    return providerUsage(rows, providers, now);
  } catch {
    console.warn("reading the provider usage failed");
    return [];
  }
}

export default async function QuotaPage() {
  const gate = await pageGate("owner"); // R2, again here: a layout doesn't stop its page from running
  if (!gate.ok) return <NoAccess role={gate.member.role} />;
  const now = new Date();
  const [groups, editable, keys, ag, router, usage] = await Promise.all([
    groupedQuota(now), limitProviders(), keyUsage(now), antigravityQuota(now), routerQuotaView(now), providerSection(now),
  ]);

  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader
        crumbs={[{ label: "Manage" }, { label: "AI Gateway", href: "/ai" }, { label: "Quota" }]}
        title="Quota"
        sub={QUOTA_PAGE_TEXT.sub}
      />

      <RouterQuotaSection view={router} now={now} />

      <div className="grid grid-cols-1 gap-4 min-[1001px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card title="Provider usage" meta={`Today (${zoneName()}) · last 7 days`} flush>
          {usage.length === 0 ? (
            <EmptyState title="No provider connected" action={<Link href="/ai/providers" className={buttonClass({ size: "sm" })}>Bring your own key</Link>}>
              Connect a provider to see its requests and tokens here.
            </EmptyState>
          ) : usage.map((p) => <ProviderUsageBlock key={p.id} p={p} groups={groups.filter((g) => g.providerId === p.id)} canLimit={editable.some((e) => e.id === p.id)} />)}
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          <Card title="Where these numbers come from">
            <p className="mb-2 text-[13px] text-ink-soft">
              From the provider&apos;s rate-limit headers when it sends them. Otherwise Watchbell counts the calls it forwards against limits you enter;
              calls made with the same account outside Watchbell aren&apos;t counted. A 429 from a provider marks the row as used up until it resets.
            </p>
            <p className="m-0 text-[12.5px] text-ink-faint">
              {QUOTA_PAGE_TEXT.sourceNote && `${QUOTA_PAGE_TEXT.sourceNote} `}Day and week windows of your limits reset at 00:00 UTC (weeks on Monday).
            </p>
          </Card>
          <Card title={<span id="limits">Limits you enter</span>}>
            {editable.length === 0 ? (
              <p className="m-0 text-[13px] text-ink-soft">Connect a provider first. <Link href="/ai/providers">Bring your own key</Link></p>
            ) : <LimitsForm providers={editable} />}
          </Card>
        </div>
      </div>

      {ag && <AntigravityQuotaCard ag={ag} />}

      <Card title="Per key" meta="Applied before the provider's limits" flush>
        {keys.length === 0 ? (
          <EmptyState title="No active keys" action={<Link href="/ai/keys" className={buttonClass({ size: "sm" })}>API keys</Link>}>Create a key to see its usage here.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <TableHead head={["Key", "Limit", "This minute", "Today", ""]} />
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td className={td}><b className="font-medium">{k.name}</b></td>
                    <td className={`${td} font-mono`}>{k.ratePerMin} / min</td>
                    <td className={`${td} font-mono`}>{k.lastMinute}<Progress pct={clampPct((k.lastMinute / k.ratePerMin) * 100)} tone={k.lastMinute >= k.ratePerMin ? "err" : k.lastMinute / k.ratePerMin >= 0.75 ? "warn" : undefined} /></td>
                    <td className={`${td} font-mono`}>{k.today.toLocaleString("en-US")}</td>
                    <td className={td}><Link href="/ai/keys" className={buttonClass({ size: "sm" })}>Change</Link></td>
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

const usageCells = (t: UsageTotals) => [
  t.requests.toLocaleString("en-US"), compactNumber(t.input), compactNumber(t.cached), compactNumber(t.output), t.errors.toLocaleString("en-US"),
];

// One provider's requests and tokens, then its limits as bars, only where a limit is set.
function ProviderUsageBlock({ p, groups, canLimit }: { p: ProviderUsage; groups: QuotaGroupRows[]; canLimit: boolean }) {
  const rows = groups.flatMap((g) => g.rows.map((r) => ({ ...r, key: `${g.group}|${r.label}`, group: g.group })));
  return (
    <section className="border-t border-line px-4 py-3 first-of-type:border-t-0">
      <h3 className="mb-1.5 flex items-center gap-2 text-[13px] font-medium">
        {p.kind === "gemini" || p.kind === "agent" ? <IconBrandGoogle size={16} aria-hidden /> : p.kind === "groq" ? <IconBolt size={16} aria-hidden /> : <IconPlug size={16} aria-hidden />}
        {p.name}{!p.enabled && <Tag>Off</Tag>}
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="text-left text-ink-soft">
              {["", "Requests", "Input", "Cached", "Output", "Errors"].map((h) => <th key={h} className="py-1 pr-3 font-medium">{h}</th>)}
            </tr>
          </thead>
          <tbody className="font-mono">
            {([["Today", p.today], ["7 days", p.week]] as const).map(([label, t]) => (
              <tr key={label} className="border-t border-line">
                <td className="py-1 pr-3 font-sans text-ink-soft">{label}</td>
                {usageCells(t).map((v, i) => <td key={i} className={i === 4 && t.errors > 0 ? "py-1 pr-3 text-err" : "py-1 pr-3"}>{v}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 0 ? (
        <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
          {rows.map((r) => (
            <li key={r.key} className="text-[12.5px]">
              <div className="flex items-baseline gap-2">
                <span className="font-medium">{r.label}</span>{r.limited && <Tag>Used up</Tag>}
                <span className="ml-auto font-mono text-ink-soft">{r.pctLeft}% left</span>
              </div>
              <Progress pct={100 - r.pctLeft} tone={r.pctLeft < 20 ? "err" : r.pctLeft < 50 ? "warn" : undefined} />
              <small className="block text-[11.5px] text-ink-faint">{r.group} · resets in {r.resetsIn} · {sourceText(r)}</small>
            </li>
          ))}
        </ul>
      ) : canLimit ? (
        <a href="#limits" className="mt-1.5 inline-block text-[12px] text-ink-faint">Add a limit to see a bar</a>
      ) : null}
    </section>
  );
}

type QuotaGroupRows = Awaited<ReturnType<typeof groupedQuota>>[number];
