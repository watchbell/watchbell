import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Workloads", "Applications"]} title="Applications" sub>
      <SkeletonTable rows={6} cols={7} />
    </PageSkeleton>
  );
}
