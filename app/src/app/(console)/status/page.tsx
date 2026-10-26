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
import { incidentFacts } from "@/lib/providers/status-feeds";
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
        sub="Your providers' public status pages, read every 5 minutes, so you know when a problem isn't your app."
        more="Alerts raised during a provider's incident are labelled with it. Cloudflare data centres (outages and maintenance) count only for SIN and CGK; an open incident is coloured by its own impact. An incident on something Watchbell doesn't watch (Firebase Test Lab, the Supabase dashboard or Management API) shows in grey." />
      <Card flush>
        <PlainTable head={HEAD} rows={rows.map((r) => ({
          key: r.provider, state: r.state, text: `${r.label} ${r.text}`,
          row: (
            <tr className={rowClass}>
              <td className={td}><b className="font-medium">{r.label}</b></td>
              <td className={cn(td, tdWrap)}>
                <Status state={r.state}>{r.text}</Status>
                {r.incidents.map((i) => {
                  // 1.2.3: the line under the status names what is affected and whether Watchbell watches it, flags
                  // an incident nobody has updated for a day, and doesn't repeat the status text above it.
                  const facts = incidentFacts(i, r.text, now);
                  return (
                    <div key={`${i.name}${i.startedAt}`} className="mt-0.5 text-[12.5px] text-ink-faint">
                      {facts}{i.url && <>{facts && " · "}<a href={i.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Open status page</a></>}
                    </div>
                  );
                })}
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
