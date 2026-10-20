import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

// Operators and owners only: the page decides who may see it, so the skeleton names nothing yet.
export default function Loading() {
  return (
    <PageSkeleton crumbs={["Observe"]}>
      <SkeletonTable rows={10} cols={4} />
    </PageSkeleton>
  );
}
