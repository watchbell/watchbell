import { PageSkeleton, SkeletonCards, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Hosting", "Uptime"]} title="Uptime" sub>
      <SkeletonCards count={4} className="min-[721px]:grid-cols-2 min-[1001px]:grid-cols-2 min-[1281px]:grid-cols-4" />
      <SkeletonTable rows={6} cols={7} />
    </PageSkeleton>
  );
}
