import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Workloads", "Deployments"]} title="Deployments" sub>
      <SkeletonTable rows={8} cols={6} />
    </PageSkeleton>
  );
}
