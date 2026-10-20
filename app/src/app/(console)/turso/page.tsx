import { IconDatabase } from "@tabler/icons-react";
import Link from "next/link";
import { Banner, buttonClass, Card, EmptyState, PageHeader } from "@/components/kit";
import { ExtraDbTable } from "@/components/extra-db-table";
import { AutoRefresh } from "@/components/live";
import { requirePageMember } from "@/lib/auth";
import { aliasBook, listDatabases } from "@/lib/data/cached";
import { TURSO_FREE } from "@/lib/databases/extra";
import { tursoViews } from "@/lib/view/extra-dbs";

// Stage 8: watched Turso databases, read hourly from the Turso Platform API (lib/collector/extra-db-tasks.ts).
export default async function TursoPage() {
  const member = await requirePageMember();
  const now = new Date();
  const [rows, book] = await Promise.all([listDatabases("turso_database"), aliasBook()]);
  const views = tursoViews(rows, now, book);
  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader
        crumbs={[{ label: "Databases" }, { label: "Turso" }]}
        title="Turso"
        sub="Databases, rows read and written and storage this month from the Turso Platform API, read hourly. The free limits are per organization, so the meters show the organization's total."
        actions={member.role === "owner" ? <Link href="/connections" className={buttonClass()}>Manage accounts</Link> : undefined}
      />
      {views.some((v) => v.stale) && (
        <Banner tone="info" title="Turso API isn't responding">Showing the last data we got. The collector retries every hour.</Banner>
      )}
      {views.length === 0 ? (
        <Card><EmptyState icon={IconDatabase} title="No Turso databases watched yet"
          action={member.role === "owner" ? <Link href="/connections" className={buttonClass({ size: "sm" })}>Open connections</Link> : undefined}>
          {member.role === "owner" ? "Connect a Turso account with a platform API token, then press Sync and tick the databases to watch." : "An owner picks the databases to watch in Connections."}
        </EmptyState></Card>
      ) : (
        <ExtraDbTable title="Databases" meta={`Free plan: ${TURSO_FREE.databases} databases, 5 GB, 500M rows read and 10M written a month`} rows={views} source="Platform API" />
      )}
    </>
  );
}
