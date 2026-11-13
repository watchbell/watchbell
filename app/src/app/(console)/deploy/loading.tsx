import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Hosting", "Deploy an app"]} title="Deploy an app" sub>
      <SkeletonTable rows={5} cols={5} />
    </PageSkeleton>
  );
}
