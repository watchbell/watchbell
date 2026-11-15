import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Home", "All workspaces"]} title="All workspaces">
      <SkeletonTable title rows={3} cols={5} />
    </PageSkeleton>
  );
}
