import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["DevOps", "Containers"]} title="Containers" sub>
      <SkeletonTable rows={5} cols={5} />
    </PageSkeleton>
  );
}
