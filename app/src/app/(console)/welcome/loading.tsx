import { PageSkeleton, SkeletonDetails } from "@/components/skeleton";

// Owners only: the page decides who may see it, so the skeleton names nothing yet.
export default function Loading() {
  return (
    <PageSkeleton crumbs={["Home"]}>
      <SkeletonDetails lines={5} title={false} />
    </PageSkeleton>
  );
}
