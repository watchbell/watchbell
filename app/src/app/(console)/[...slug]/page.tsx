import { IconTools } from "@tabler/icons-react";
import { notFound } from "next/navigation";
import { Card, EmptyState, PageHeader } from "@/components/kit";
import { NoAccess } from "@/components/no-access";
import { requirePageMember } from "@/lib/auth";
import { extensions } from "@/lib/extensions";
import { canSee, findNav, groupOf } from "@/lib/nav";

export default async function NotBuiltYet({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const item = findNav("/" + slug.join("/"), extensions);
  if (!item) notFound();
  const member = await requirePageMember();
  if (!canSee(item, member.role)) return <NoAccess role={member.role} />;
  return (
    <>
      <PageHeader crumbs={[{ label: groupOf(item.key, extensions) }, { label: item.label }]} title={item.label} />
      <Card>
        <EmptyState icon={IconTools} title={`${item.label} arrives in stage ${item.stage}`}>
          This page is in the mockup and gets built in stage {item.stage}. Connections and Settings work now.
        </EmptyState>
      </Card>
    </>
  );
}
