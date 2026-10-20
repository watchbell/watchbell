import Link from "next/link";
import { MaskedText } from "@/components/alias";
import { StateIcon } from "@/components/status";
import type { State } from "@/lib/status";
import { STATE_WORD } from "@/lib/view/labels";

type Cell = { name: string; href: string; state: State; sub: string };

type Strip = { state: State; sub: string };

// Mockup section 1, block 1.
export function StatusStrip({ vercel, supabase, neon, firebase, cloudflare, collector }: { vercel: Strip; supabase: Strip; neon: Strip; firebase: Strip; cloudflare: Strip; collector: Strip }) {
  const cells: Cell[] = [
    { name: "Vercel", href: "/apps", ...vercel },
    { name: "Supabase", href: "/supabase", ...supabase },
    { name: "Neon", href: "/neon", ...neon },
    { name: "Firebase", href: "/firebase", ...firebase },
    { name: "Cloudflare", href: "/domains", ...cloudflare },
    { name: "Collector", href: "/settings", ...collector },
  ];
  return (
    <div className="grid grid-cols-6 rounded-lg border border-line bg-surface max-[1280px]:grid-cols-3 max-[720px]:grid-cols-2">
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
