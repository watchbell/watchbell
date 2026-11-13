import { PageSkeleton, SkeletonCards, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["DevOps", "OS vulnerabilities"]} title="OS vulnerabilities" sub>
      <SkeletonCards count={2} />
      <SkeletonTable rows={4} cols={3} />
    </PageSkeleton>
  );
}
