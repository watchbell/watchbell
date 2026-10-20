import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

// Owners only: the page decides who may see it, so the skeleton names nothing yet.
export default function Loading() {
  return (
    <PageSkeleton crumbs={["AI & API"]}>
      <SkeletonTable title rows={2} cols={6} />
    </PageSkeleton>
  );
}
