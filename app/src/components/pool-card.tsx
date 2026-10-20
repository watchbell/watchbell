import Link from "next/link";
import { closeIdleForm } from "@/app/(console)/supabase/pool-actions";
import { buttonClass, Card, Progress } from "@/components/kit";
import { POOL_CAP, POOL_SLOTS, type PoolUsage, poolView } from "@/lib/data/pool-guard";
import { cn } from "@/lib/utils";

// Watchbell's own pooler connections (owner 16 Oct): on the Supabase page and on Overview. % of the 15 slots, each
// connection's idle time and last table (the culprit), and the owner's "Close idle connections".
export function PoolCard({ pool, owner, compact = false }: { pool: PoolUsage; owner: boolean; compact?: boolean }) {
  const v = poolView(pool);
  return (
    <Card title="Watchbell connections" meta={compact ? <Link href="/supabase">Supabase</Link> : undefined}>
      <span className="text-[26px] font-semibold tracking-tight">{pool.used}<small className="ml-1 text-[13px] font-normal text-ink-soft">of {POOL_SLOTS} pooler slots · {v.pct}%</small></span>
      <Progress pct={v.pct} tone={v.warn ? "warn" : undefined} />
      <p className="mt-2 text-[12.5px] text-ink-soft">{pool.active} busy now. From {POOL_CAP} on, the longest-idle ones (and idle doubles) are closed every minute.</p>
      {pool.conns.length > 0 && (
        <ul className="mt-2 space-y-0.5 font-mono text-[11.5px] text-ink-soft">
          {pool.conns.slice(0, compact ? 5 : 8).map((c, i) => (
            <li key={i} className={cn(c.busy && "text-ink")}>
              {c.busy ? "busy" : `idle ${c.idleS}s`} · {c.table ?? "—"} · open {Math.round(c.ageS / 60)}m
            </li>
          ))}
        </ul>
      )}
      {owner && (
        <form action={closeIdleForm} className="mt-2">
          <button type="submit" className={buttonClass({ size: "sm" })}>Close idle connections</button>
        </form>
      )}
    </Card>
  );
}
