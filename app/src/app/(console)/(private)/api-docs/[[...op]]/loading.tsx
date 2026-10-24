import { PageSkeleton, SkeletonDetails } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Manage", "API explorer"]} title="API explorer" sub>
      <div className="grid grid-cols-1 items-start gap-4 min-[960px]:grid-cols-[268px_minmax(0,1fr)]">
        <SkeletonDetails lines={10} title={false} />
        <SkeletonDetails lines={8} />
      </div>
    </PageSkeleton>
  );
}
