import { IconApps } from "@tabler/icons-react";
import Link from "next/link";
import { buttonClass, Card, EmptyState, PageHeader } from "@/components/kit";

// An app id that isn't a UUID, isn't watched, or was just removed from the console.
export default function AppNotFound() {
  return (
    <>
      <PageHeader crumbs={[{ label: "Applications", href: "/apps" }, { label: "Not found" }]} title="Application" />
      <Card>
        <EmptyState
          icon={IconApps}
          title="That app isn't in the console"
          action={<Link href="/apps" className={buttonClass({ size: "sm" })}>Back to Applications</Link>}
        >
          It may have been removed, or the link is wrong.
        </EmptyState>
      </Card>
    </>
  );
}
