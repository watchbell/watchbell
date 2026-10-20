import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["GitHub", "Repositories"]} title="Repositories" sub>
      <SkeletonTable rows={8} cols={7} />
    </PageSkeleton>
  );
}
