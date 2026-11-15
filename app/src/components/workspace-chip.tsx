import { Tag } from "@/components/kit";

// Watchbell 1.8 (spec §5, detail pages): the workspace a thing is in, next to its title. The page passes null when the
// install has one workspace, so nothing changes there.
export function WorkspaceChip({ name }: { name: string | null }) {
  if (!name) return null;
  return <Tag>in {name}</Tag>;
}
