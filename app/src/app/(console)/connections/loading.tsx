import { Bone, PageSkeleton } from "@/components/skeleton";

// Owners only: the page decides who may see it, so the skeleton names nothing yet. Laid out like the page: a section
// heading and a grid of provider tiles per section (1.2).
const SECTIONS = [2, 5, 2, 1];

export default function Loading() {
  return (
    <PageSkeleton crumbs={["Manage"]}>
      {SECTIONS.map((tiles, s) => (
        <div key={s}>
          <Bone className="mb-2 w-20" />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2.5">
            {Array.from({ length: tiles }, (_, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3.5 py-3">
                <Bone className="size-9 rounded-lg" />
                <div className="flex-1"><Bone className="w-24" /><Bone className="mt-1.5 w-16" /></div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </PageSkeleton>
  );
}
