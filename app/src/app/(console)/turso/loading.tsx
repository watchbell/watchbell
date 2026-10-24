import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Database", "Turso"]} title="Turso" sub>
      <SkeletonTable title rows={2} cols={8} />
    </PageSkeleton>
  );
}
