import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["AI & API", "AI Gateway", "API keys"]} title="API keys" sub>
      <SkeletonTable rows={4} cols={10} />
    </PageSkeleton>
  );
}
