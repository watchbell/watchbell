import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Observe", "Provider status"]} title="Provider status" sub>
      <SkeletonTable rows={6} cols={4} />
    </PageSkeleton>
  );
}
