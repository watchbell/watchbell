import { IconBox } from "@tabler/icons-react";
import { Card, EmptyState, PageHeader } from "@/components/kit";
import { requirePageMember } from "@/lib/auth";
import { dockerState, type ListedContainer, loadContainers, OFF_CLOUD, OFF_SWITCH } from "@/lib/data/docker-db";
import { DEMO_CONTAINERS } from "@/lib/docker/demo";
import { ContainersView } from "./containers-view";

// Watchbell 1.5 DevOps › Containers (10c): the Docker containers on the machine a self-hosted Watchbell runs on. Read
// when the page opens and on Refresh only; no polling, no alerts. Operators and owners; actions are the owner's.
export default async function ContainersPage() {
  const member = await requirePageMember();
  const state = dockerState();
  let containers: ListedContainer[] | null = null;
  let error: string | null = null;
  if (member.role === "viewer") error = "Containers are for operators and owners.";
  else if (state === "off-cloud") error = OFF_CLOUD;
  else if (state === "off-switch") error = OFF_SWITCH;
  else if (state === "demo") containers = DEMO_CONTAINERS;
  else {
    const r = await loadContainers();
    if (r.ok) containers = r.data.containers;
    else error = r.error;
  }
  return (
    <>
      <PageHeader
        crumbs={[{ label: "DevOps" }, { label: "Containers" }]}
        title="Containers"
        sub="The Docker containers on this machine. Read when you open the page or press Refresh; the owner can start, stop and restart them."
      />
      <Card flush>
        {containers === null ? (
          <EmptyState icon={IconBox} title="Containers can't be shown">{error}</EmptyState>
        ) : (
          <ContainersView initial={containers} owner={member.role === "owner"} />
        )}
      </Card>
    </>
  );
}
