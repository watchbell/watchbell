import { IconBrandGithub } from "@tabler/icons-react";
import Link from "next/link";
import { buttonClass, Card, EmptyState, PageHeader } from "@/components/kit";

// A repository id that isn't a UUID or isn't a synced repository.
export default function RepoNotFound() {
  return (
    <>
      <PageHeader crumbs={[{ label: "Repositories", href: "/repos" }, { label: "Not found" }]} title="Repository" />
      <Card>
        <EmptyState
          icon={IconBrandGithub}
          title="That repository isn't in the console"
          action={<Link href="/repos" className={buttonClass({ size: "sm" })}>Back to Repositories</Link>}
        >
          It may no longer be shared with the GitHub token, or the link is wrong.
        </EmptyState>
      </Card>
    </>
  );
}
