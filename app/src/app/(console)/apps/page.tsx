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
import { currentWorkspace } from "@/lib/workspace/current";
import { UnsortedNote } from "@/components/unsorted-note";
import { unsortedCount } from "@/lib/data/workspace-db";
import { MoveToWorkspace } from "@/components/move-to-workspace";
import { soft } from "@/lib/soft";

// "Refresh now" runs the collector inside this page's server action.
export const maxDuration = 30;

export default async function AppsPage() {
  const member = await requirePageMember();
  const now = new Date();
  const act = canAct(member.role);
  const wsc = await currentWorkspace(); // 1.8: the workspace shown and the list to move to
  const ws = wsc.id;
  const [apps, book, unsorted] = await Promise.all([listApps(now, undefined, ws), aliasBook(), soft(unsortedCount(now), 0, "unsorted count")]);
  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader
        crumbs={[{ label: "Hosting" }, { label: "Applications" }]}
        title="Applications"
        sub="Vercel projects with their database, domain, and uptime."
        actions={act ? <RefreshButton /> : undefined}
      />
      {act && <MoveToWorkspace kind="resource" items={apps.map((a) => ({ id: a.id, name: a.name }))} workspaces={wsc.list} current={wsc.id} />}
      <UnsortedNote count={unsorted} />
      <Card flush>
        {apps.length === 0
          ? <NoApps owner={member.role === "owner"} />
          : <ListFilter placeholder="Filter by name" states={APP_STATE_OPTIONS} head={appHead(false)} rows={appListRows(apps, { compact: false, canAct: act, now, book })} />}
      </Card>
    </>
  );
}
