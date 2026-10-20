import { Card } from "@/components/kit";
import { Bone, PageSkeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Home", "Topology"]} title="Topology" sub>
      <Card>
        <div className="grid grid-cols-1 gap-6 min-[721px]:grid-cols-4">
          {Array.from({ length: 4 }, (_, c) => (
            <div key={c} className="flex flex-col gap-3">
              <Bone className="w-20" />
              {Array.from({ length: 3 }, (_, r) => <Bone key={r} className="h-9 w-full" />)}
            </div>
          ))}
        </div>
      </Card>
    </PageSkeleton>
  );
}
