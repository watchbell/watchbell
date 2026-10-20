import { PageSkeleton, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Databases", "Firebase"]} title="Firebase" sub>
      <SkeletonTable rows={4} cols={9} />
    </PageSkeleton>
  );
}
