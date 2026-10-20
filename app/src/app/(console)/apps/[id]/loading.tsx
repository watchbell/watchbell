import { Bone, PageSkeleton, SkeletonDetails } from "@/components/skeleton";

// The app's name comes from the data, so the title is a bone; the tabs and the detail cards keep their place.
export default function Loading() {
  return (
    <PageSkeleton crumbs={["Applications"]}>
      <div className="flex gap-5 border-b border-line pb-2">{["w-14", "w-14", "w-24", "w-10"].map((w, i) => <Bone key={i} className={w} />)}</div>
      <div className="grid grid-cols-1 gap-4 min-[1001px]:grid-cols-2">
        <SkeletonDetails lines={7} />
        <SkeletonDetails lines={6} />
      </div>
      <SkeletonDetails lines={3} />
    </PageSkeleton>
  );
}
