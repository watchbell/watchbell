import { IconBrandGithub } from "@tabler/icons-react";
import Link from "next/link";
import { buttonClass, Card, EmptyState, PageHeader } from "@/components/kit";
import { requirePageMember } from "@/lib/auth";
import { listRepoItems } from "@/lib/data/repos-db";
import { RepoList } from "./repo-list";

// GitHub → Repositories (owner 16 Oct: "just show the projects", clickable, leading to the project). Read-only: the
// repositories the GitHub sync stored (Connections), their linked apps, open advisories from the dependency scan and the
// latest Actions status the sync read. Owner and members, like the other console pages.

export default async function ReposPage() {
  const member = await requirePageMember();
  const now = new Date();
  const list = await listRepoItems();
  const owner = member.role === "owner";
  return (
    <>
      <PageHeader
        crumbs={[{ label: "GitHub" }, { label: "Repositories" }]}
        title="Repositories"
        sub="The repositories the GitHub token can read. Open one for its README, files, commits and checks. Read-only."
      />
      <Card flush>
        {list.items.length === 0 ? (
          <EmptyState
            icon={IconBrandGithub}
            title={list.connected ? "No repositories synced yet" : "GitHub isn't connected"}
            action={owner ? <Link href="/connections" className={buttonClass({ size: "sm" })}>Open connections</Link> : undefined}
          >
            {owner ? (list.connected ? "Press Sync on the GitHub connection to list the repositories." : "Add a read-only GitHub token on Connections.") : "An owner connects GitHub in Connections."}
          </EmptyState>
        ) : (
          <>
            {list.languageNote && <p className="px-[18px] pt-1 text-[12.5px] text-ink-faint">{list.languageNote}</p>}
            <RepoList items={list.items} nowMs={now.getTime()} />
          </>
        )}
      </Card>
    </>
  );
}
