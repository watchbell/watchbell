import { IconLock } from "@tabler/icons-react";
import { Card, EmptyState, PageHeader } from "@/components/kit";
import type { Role } from "@/lib/roles";

export function NoAccess({ role }: { role: Role }) {
  return (
    <>
      <PageHeader crumbs={[{ label: "Watchbell" }]} title="No access" />
      <Card>
        <EmptyState icon={IconLock} title="You don't have access to this page">
          You&apos;re signed in as {role === "viewer" ? "a Viewer" : "an Operator"}. Ask an owner if you need it.
        </EmptyState>
      </Card>
    </>
  );
}
