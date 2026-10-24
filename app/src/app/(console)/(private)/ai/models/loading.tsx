import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

// Owner only: the (private) layout decides who may see the page, so the skeleton names nothing yet.
export default function Loading() {
  return (
    <PageSkeleton crumbs={["Manage", "AI Gateway"]}>
      <SkeletonTable rows={8} cols={6} />
    </PageSkeleton>
  );
}
