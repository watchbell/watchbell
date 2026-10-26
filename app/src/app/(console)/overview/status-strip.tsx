import Link from "next/link";
import { MaskedText } from "@/components/alias";
import { StateIcon } from "@/components/status";
import type { State } from "@/lib/status";
import { cn } from "@/lib/utils";
import { STATE_WORD } from "@/lib/view/labels";

type Cell = { name: string; href: string; state: State; sub: string };

// `empty`: nothing of that provider is watched yet (1.2.3, UI audit C3). Such a cell is left out, so someone with only
// Vercel sees Vercel and the collector instead of grey "No projects watched yet" cells; Connections lists the rest.
type Strip = { state: State; sub: string; empty?: boolean };

// Columns for 1–6 cells (Tailwind needs the class names written out).
const COLS = ["grid-cols-1", "grid-cols-2", "grid-cols-3", "grid-cols-4", "grid-cols-5", "grid-cols-6"] as const;

export function StatusStrip({ vercel, supabase, neon, firebase, cloudflare, collector }: { vercel: Strip; supabase: Strip; neon: Strip; firebase: Strip; cloudflare: Strip; collector: Strip }) {
  const all: (Cell & { empty?: boolean })[] = [
    { name: "Vercel", href: "/apps", ...vercel },
    { name: "Supabase", href: "/supabase", ...supabase },
    { name: "Neon", href: "/neon", ...neon },
    { name: "Firebase", href: "/firebase", ...firebase },
    { name: "Cloudflare", href: "/domains", ...cloudflare },
    { name: "Collector", href: "/settings", ...collector },
  ];
  const cells = all.filter((c) => !c.empty || c.name === "Collector");
  return (
    <div className={cn("grid rounded-lg border border-line bg-surface max-[720px]:grid-cols-2", COLS[cells.length - 1], cells.length > 3 && "max-[1280px]:grid-cols-3")}>
      {cells.map((c) => (
        <Link key={c.name} href={c.href} className="min-w-0 border-r border-line px-3.5 py-2.5 text-ink last:border-r-0 hover:bg-hover hover:no-underline max-[1280px]:border-b">
          <div className="flex items-center gap-[7px] font-medium">
            <StateIcon state={c.state} />{c.name}<span className="sr-only">, {STATE_WORD[c.state]}</span>
          </div>
          <div className="truncate pl-6 text-[12.5px] text-ink-soft"><MaskedText text={c.sub} inLink /></div>
        </Link>
      ))}
    </div>
  );
}
