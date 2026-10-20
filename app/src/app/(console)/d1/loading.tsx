import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Databases", "Cloudflare D1"]} title="Cloudflare D1" sub>
      <SkeletonTable title rows={2} cols={8} />
    </PageSkeleton>
  );
}
