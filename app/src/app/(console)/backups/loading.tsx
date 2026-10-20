import { PageSkeleton, SkeletonCards, SkeletonTable } from "@/components/skeleton";

// Owners only: the page decides who may see it, so the skeleton names nothing yet.
export default function Loading() {
  return (
    <PageSkeleton crumbs={["Administration"]}>
      <SkeletonCards count={4} />
      <SkeletonTable title rows={3} cols={6} />
    </PageSkeleton>
  );
}
