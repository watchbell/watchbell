import { Bone, PageSkeleton, SkeletonDetails } from "@/components/skeleton";

// The repository's name comes from the data, so the title is a bone; the tabs and the card keep their place.
export default function Loading() {
  return (
    <PageSkeleton crumbs={["Repositories"]}>
      <SkeletonDetails lines={4} />
      <div className="flex gap-5 border-b border-line pb-2">{["w-16", "w-12", "w-16", "w-16", "w-14", "w-24"].map((w, i) => <Bone key={i} className={w} />)}</div>
      <SkeletonDetails lines={8} />
    </PageSkeleton>
  );
}
