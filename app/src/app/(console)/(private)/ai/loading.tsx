import { PageSkeleton, SkeletonCards } from "@/components/skeleton";

// Owner only: the (private) layout decides who may see the page, so the skeleton names nothing yet.
export default function Loading() {
  return (
    <PageSkeleton crumbs={["Manage", "AI Gateway"]}>
      <SkeletonCards count={4} />
    </PageSkeleton>
  );
}
