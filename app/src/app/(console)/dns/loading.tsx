import { PageSkeleton, SkeletonDetails, SkeletonTable } from "@/components/skeleton";

// The title is the zone's name, read from the data, so it is a bone.
export default function Loading() {
  return (
    <PageSkeleton crumbs={["Network", "DNS records"]} sub>
      <SkeletonDetails lines={5} />
      <SkeletonTable rows={8} cols={6} />
    </PageSkeleton>
  );
}
