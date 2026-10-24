import type { ReactNode } from "react";
import { Card, PageHeader } from "@/components/kit";
import { AutoRefresh } from "@/components/live";
import { PlainTable } from "@/components/plain-table";
import { Src } from "@/components/sources";
import { Status } from "@/components/status";
import { rowClass, td, tdWrap } from "@/components/table";
import { requirePageMember } from "@/lib/auth";
import { readProviderStatus } from "@/lib/data/cached";
import { providerStatusView } from "@/lib/data/provider-status-db";
import { cn } from "@/lib/utils";

const HEAD: ReactNode[] = ["Provider", <span key="s">Status<Src kind="api" /></span>, "Feed", "Checked"];

export default async function ProviderStatusPage() {
  await requirePageMember();
  const now = new Date();
  const rows = providerStatusView(await readProviderStatus(), now);
  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader crumbs={[{ label: "Home" }, { label: "Provider status" }]} title="Provider status"
        sub="Public status feeds, polled every 5 minutes. When a provider has an incident, its alerts are labelled so you know the problem isn't your app. Cloudflare data centres (outages and maintenance) count only for SIN and CGK; an open incident is coloured by its own impact." />
      <Card flush>
        <PlainTable head={HEAD} rows={rows.map((r) => ({
          key: r.provider, state: r.state, text: `${r.label} ${r.text}`,
          row: (
            <tr className={rowClass}>
              <td className={td}><b className="font-medium">{r.label}</b></td>
              <td className={cn(td, tdWrap)}>
                <Status state={r.state}>{r.text}</Status>
                {r.incidents.map((i) => (
                  <div key={`${i.name}${i.startedAt}`} className="mt-0.5 text-[12.5px] text-ink-faint">
                    {i.name}{i.url && <> · <a href={i.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Open status page</a></>}
                  </div>
                ))}
              </td>
              <td className={cn(td, "text-ink-soft")}>{r.feedText}</td>
              <td className={cn(td, "text-ink-soft")}>{r.checked}</td>
            </tr>
          ),
        }))} />
      </Card>
    </>
  );
}
