import { PageSkeleton, SkeletonDetails } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Manage", "Sections"]} title="Sections" sub>
      <SkeletonDetails lines={5} />
    </PageSkeleton>
  );
}
