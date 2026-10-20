import { Bone, PageSkeleton, SkeletonCards, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Databases", "Neon"]} title="Neon" sub>
      <Bone className="h-5 w-48" />
      <SkeletonCards count={4} className="min-[721px]:grid-cols-2 min-[1001px]:grid-cols-2 min-[1281px]:grid-cols-4" />
      <SkeletonTable title rows={2} cols={7} />
    </PageSkeleton>
  );
}
