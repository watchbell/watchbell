import { Bone, PageSkeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Databases", "SQL console"]} title="SQL console" sub>
      <Bone className="h-8 w-72" />
      <Bone className="h-[260px] w-full" />
    </PageSkeleton>
  );
}
