import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Databases", "Upstash Redis"]} title="Upstash Redis" sub>
      <SkeletonTable title rows={2} cols={8} />
    </PageSkeleton>
  );
}
