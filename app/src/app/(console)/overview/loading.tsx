import { Card } from "@/components/kit";
import { Bone, PageSkeleton, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Home", "Overview"]} title="Overview">
      <div className="grid grid-cols-2 gap-3 min-[721px]:grid-cols-3 min-[1281px]:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => <Card key={i}><Bone className="w-20" /><Bone className="mt-2 w-14" /></Card>)}
      </div>
      <div className="grid grid-cols-1 gap-4 min-[1001px]:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title={<Bone className="w-24" />}><Bone className="h-[120px] w-full" /></Card>
        <Card title={<Bone className="w-20" />}><div className="flex flex-col gap-3">{Array.from({ length: 5 }, (_, i) => <Bone key={i} className="w-full" />)}</div></Card>
      </div>
      <SkeletonTable title rows={4} cols={6} />
    </PageSkeleton>
  );
}
