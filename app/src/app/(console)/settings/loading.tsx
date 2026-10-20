import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

// Owners only: the page decides who may see it, so the skeleton names nothing yet.
export default function Loading() {
  return (
    <PageSkeleton crumbs={["Administration"]}>
      <SkeletonTable rows={4} cols={4} />
    </PageSkeleton>
  );
}
