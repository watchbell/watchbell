import { PageSkeleton, SkeletonCards, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Databases", "Free databases"]} title="Free databases" sub>
      <SkeletonCards count={4} />
      <SkeletonTable rows={8} cols={7} />
    </PageSkeleton>
  );
}
