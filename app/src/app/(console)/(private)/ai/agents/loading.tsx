import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["AI & API", "AI Gateway", "Agents"]} title="Agents" sub>
      <SkeletonTable rows={4} cols={12} />
    </PageSkeleton>
  );
}
