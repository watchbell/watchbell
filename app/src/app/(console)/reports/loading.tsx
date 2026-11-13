import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Manage", "Reports"]} title="Reports" sub>
      <SkeletonTable title rows={2} cols={3} />
    </PageSkeleton>
  );
}
