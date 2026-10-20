import { Card } from "@/components/kit";
import { tableClass, td, th } from "@/components/table";
import { cn } from "@/lib/utils";

// Loading skeletons (perf P1): what a console route shows the moment it is opened, while its data loads. Plain blocks
// in the console's own tokens (the sunken grey of a progress track) with a soft pulse that stops for reduced motion,
// laid out like the cards and tables the page is about to show, so nothing jumps when it arrives.

export function Bone({ className }: { className?: string }) {
  // Dark theme: sunken is almost the card's own colour there (review m5), so the bone takes the line tone instead.
  return <span aria-hidden="true" className={cn("block h-3.5 animate-pulse rounded bg-sunken motion-reduce:animate-none dark:bg-line", className)} />;
}

// The page header as PageHeader draws it. The crumbs and the title are known up front for most routes, so they show
// at once; a title that comes from the data (an app's name, a zone) or a page only some roles may open is a bone.
function SkeletonHeader({ crumbs, title, sub }: { crumbs: string[]; title?: string; sub?: boolean }) {
  return (
    <div>
      <div className="text-[12.5px] text-ink-faint">
        {crumbs.map((c, i) => <span key={`${c}-${i}`}>{i > 0 && " / "}<span>{c}</span></span>)}
      </div>
      {title ? <h1 className="text-[22px]">{title}</h1> : <Bone className="mt-1.5 h-[26px] w-56" />}
      {sub && <Bone className="mt-2 w-full max-w-[620px]" />}
    </div>
  );
}

// A row of summary cards (Uptime's Up/Degraded/Down, Supabase's slots): a title and one big number each.
export function SkeletonCards({ count, className }: { count: number; className?: string }) {
  return (
    <div className={cn("grid grid-cols-1 gap-4 min-[1001px]:grid-cols-3", className)}>
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} title={<Bone className="w-24" />}>
          <Bone className="mt-1 h-[26px] w-16" />
        </Card>
      ))}
    </div>
  );
}

// A card with a few label/value lines (an app's Details, the DNS zone).
export function SkeletonDetails({ lines = 5, title = true }: { lines?: number; title?: boolean }) {
  return (
    <Card title={title ? <Bone className="w-28" /> : undefined}>
      <div className="flex flex-col gap-3 py-1">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className="grid grid-cols-[170px_minmax(0,1fr)] gap-x-4 max-[720px]:grid-cols-1 max-[720px]:gap-y-1">
            <Bone className="w-24" />
            <Bone className={i % 2 ? "w-2/5" : "w-3/5"} />
          </div>
        ))}
      </div>
    </Card>
  );
}

// The mockup's table inside a flush card: the grey header band, then rows of 9 px padding.
export function SkeletonTable({ rows = 6, cols = 5, title }: { rows?: number; cols?: number; title?: boolean }) {
  const widths = ["w-40", "w-20", "w-28", "w-16", "w-24", "w-12", "w-20"];
  return (
    <Card flush title={title ? <Bone className="w-32" /> : undefined}>
      <div className="overflow-hidden">
        <table className={tableClass}>
          <thead><tr>{Array.from({ length: cols }, (_, c) => <th key={c} className={th}><Bone className="w-14" /></th>)}</tr></thead>
          <tbody>
            {Array.from({ length: rows }, (_, r) => (
              <tr key={r}>
                {Array.from({ length: cols }, (_, c) => <td key={c} className={td}><Bone className={c === 0 ? "w-40" : widths[(c + r) % widths.length]} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// The whole page: header first, then whatever shapes the route passes (cards, tables) in the shell's column.
export function PageSkeleton({ crumbs, title, sub, children }: { crumbs: string[]; title?: string; sub?: boolean; children?: React.ReactNode }) {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">{`Loading ${title ?? "page"}`}</span>
      <SkeletonHeader crumbs={crumbs} title={title} sub={sub} />
      {children}
    </div>
  );
}
