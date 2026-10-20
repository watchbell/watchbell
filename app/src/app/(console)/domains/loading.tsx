import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Network", "Domains"]} title="Domains" sub>
      <SkeletonTable rows={6} cols={7} />
    </PageSkeleton>
  );
}
