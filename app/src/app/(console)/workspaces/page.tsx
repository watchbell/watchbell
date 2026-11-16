import { PageHeader } from "@/components/kit";
import { requirePageMember } from "@/lib/auth";
import { defaultWorkspaceId, listWorkspaces, unsortedResources, workspaceSummaries } from "@/lib/data/workspace-db";
import { WorkspacesView } from "./workspaces-view";

// Watchbell 1.8 (spec §5): All workspaces, for every member (workspaces are a grouping, not a boundary).
export default async function WorkspacesPage() {
  const member = await requirePageMember();
  const now = new Date();
  const [sums, list, def] = await Promise.all([workspaceSummaries(now), listWorkspaces(), defaultWorkspaceId()]);
  const unsorted = list.length > 1 ? await unsortedResources(now) : [];
  return (
    <>
      <PageHeader crumbs={[{ label: "Home" }, { label: "All workspaces" }]} title="All workspaces" />
      <div className="mt-3.5"><WorkspacesView workspaces={sums.workspaces} install={sums.install} now={now.getTime()} unsorted={unsorted} defaultName={list.find((w) => w.id === def)?.name ?? "Personal"} canEdit={member.role !== "viewer"} targets={list.filter((w) => w.id !== def).map((w) => ({ id: w.id, name: w.name }))} /></div>
    </>
  );
}
