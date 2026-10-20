import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Observe", "Alerts"]} title="Alerts" sub>
      <SkeletonTable title rows={3} cols={5} />
      <SkeletonTable title rows={4} cols={5} />
    </PageSkeleton>
  );
}
