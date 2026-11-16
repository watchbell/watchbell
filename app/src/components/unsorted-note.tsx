import { HoverLink as Link } from "@/components/hover-link";

// Watchbell 1.8 (spec §5, New things): new apps, databases and domains wait in the default workspace until someone
// moves them or leaves them there. Overview and Applications say so; nothing shows with a single workspace (count 0).
export function UnsortedNote({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <p className="mb-3 text-[13px] text-ink-soft">
      <Link href="/workspaces#unsorted">{count} new, not sorted into a workspace yet</Link>
    </p>
  );
}
