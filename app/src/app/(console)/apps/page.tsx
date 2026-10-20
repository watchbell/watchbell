import { NoApps } from "@/components/empty-states";
import { Card, PageHeader } from "@/components/kit";
import { ListFilter } from "@/components/list-filter";
import { AutoRefresh } from "@/components/live";
import { RefreshButton } from "@/components/refresh-button";
import { requirePageMember } from "@/lib/auth";
import { listApps } from "@/lib/data/apps-db";
import { aliasBook } from "@/lib/data/cached";
import { APP_STATE_OPTIONS, canAct } from "@/lib/view/labels";
import { appHead, appListRows } from "./app-table";

// "Refresh now" runs the collector inside this page's server action.
export const maxDuration = 30;

export default async function AppsPage() {
  const member = await requirePageMember();
  const now = new Date();
  const act = canAct(member.role);
  const [apps, book] = await Promise.all([listApps(now), aliasBook()]);
  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader
        crumbs={[{ label: "Workloads" }, { label: "Applications" }]}
        title="Applications"
        sub="Vercel projects with their database, domain, and uptime."
        actions={act ? <RefreshButton /> : undefined}
      />
      <Card flush>
        {apps.length === 0
          ? <NoApps owner={member.role === "owner"} />
          : <ListFilter placeholder="Filter by name" states={APP_STATE_OPTIONS} head={appHead(false)} rows={appListRows(apps, { compact: false, canAct: act, now, book })} />}
      </Card>
    </>
  );
}
