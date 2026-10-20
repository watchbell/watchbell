import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Home", "Events"]} title="Events" sub>
      <SkeletonTable rows={10} cols={5} />
    </PageSkeleton>
  );
}
