import { IconBolt } from "@tabler/icons-react";
import Link from "next/link";
import { Banner, buttonClass, Card, EmptyState, PageHeader } from "@/components/kit";
import { ExtraDbTable } from "@/components/extra-db-table";
import { AutoRefresh } from "@/components/live";
import { requirePageMember } from "@/lib/auth";
import { aliasBook, listDatabases } from "@/lib/data/cached";
import { upstashViews } from "@/lib/view/extra-dbs";

// Stage 8: watched Upstash Redis databases, read hourly from the Upstash Developer API (lib/collector/extra-db-tasks.ts).
export default async function UpstashPage() {
  const member = await requirePageMember();
  const now = new Date();
  const [rows, book] = await Promise.all([listDatabases("upstash_redis"), aliasBook()]);
  const views = upstashViews(rows, now, book);
  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader
        crumbs={[{ label: "Databases" }, { label: "Upstash Redis" }]}
        title="Upstash Redis"
        sub="Region, commands and bandwidth this month and data size from the Upstash Developer API, read hourly with a read-only key. The console never connects to Redis itself."
        actions={member.role === "owner" ? <Link href="/connections" className={buttonClass()}>Manage accounts</Link> : undefined}
      />
      {views.some((v) => v.stale) && (
        <Banner tone="info" title="Upstash API isn't responding">Showing the last data we got. The collector retries every hour.</Banner>
      )}
      {views.length === 0 ? (
        <Card><EmptyState icon={IconBolt} title="No Upstash Redis databases watched yet"
          action={member.role === "owner" ? <Link href="/connections" className={buttonClass({ size: "sm" })}>Open connections</Link> : undefined}>
          {member.role === "owner" ? "Connect an Upstash account with a read-only Developer API key, then press Sync and tick the databases to watch." : "An owner picks the databases to watch in Connections."}
        </EmptyState></Card>
      ) : (
        <ExtraDbTable title="Redis databases" meta="Free plan per database: 500k commands a month, 256 MB data (250 MB used here), 10 GB bandwidth" rows={views} source="Developer API" />
      )}
    </>
  );
}
