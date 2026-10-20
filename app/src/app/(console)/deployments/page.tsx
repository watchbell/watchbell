import { NoDeployments } from "@/components/empty-states";
import { Card, PageHeader } from "@/components/kit";
import { ListFilter } from "@/components/list-filter";
import { AutoRefresh } from "@/components/live";
import { requirePageMember } from "@/lib/auth";
import { listDeployments } from "@/lib/data/deployments-db";
import { canAct, DEP_STATE_OPTIONS } from "@/lib/view/labels";
import { DEPLOY_HEAD, deploymentRows } from "./deployment-rows";

export default async function DeploymentsPage() {
  const member = await requirePageMember();
  const now = new Date();
  const list = await listDeployments();
  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader
        crumbs={[{ label: "Workloads" }, { label: "Deployments" }]}
        title="Deployments"
        sub="Read from the Vercel API every minute. Hobby can only roll back to the previous production deployment."
      />
      <Card flush>
        {list.length === 0
          ? <NoDeployments />
          : <ListFilter placeholder="Filter by project or commit" states={DEP_STATE_OPTIONS} head={DEPLOY_HEAD} rows={deploymentRows(list, { canAct: canAct(member.role), now })} />}
      </Card>
    </>
  );
}
