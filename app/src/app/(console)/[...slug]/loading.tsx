import { PageSkeleton, SkeletonDetails } from "@/components/skeleton";

// A page that isn't built yet: its name comes from the URL, so the header is bones.
export default function Loading() {
  return (
    <PageSkeleton crumbs={[]}>
      <SkeletonDetails lines={2} title={false} />
    </PageSkeleton>
  );
}
