import { PageSkeleton, SkeletonCards, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Databases", "Supabase"]} title="Supabase" sub>
      <SkeletonCards count={3} />
      <SkeletonTable rows={4} cols={8} />
    </PageSkeleton>
  );
}
