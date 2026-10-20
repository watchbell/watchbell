import type { ReactNode } from "react";
import { Card, Progress } from "@/components/kit";
import { AccountChip, Resource } from "@/components/resource";
import { Src } from "@/components/sources";
import { Status } from "@/components/status";
import { rowClass, tableClass, TableHead, td, tdWrap } from "@/components/table";
import { cn } from "@/lib/utils";
import type { ExtraView, Meter } from "@/lib/view/extra-dbs";

// Stage 8: the Turso, Upstash and D1 pages' table (like Neon's: one row per watched database, every free-plan number
// with its source). Server component; the page checked membership.
const faint = "text-[12px] text-ink-faint";

function MeterCell({ m }: { m: Meter }) {
  return (
    <td className={td}>
      <span className="font-mono">{m.value}</span> <span className="text-ink-faint">{m.of}</span>
      {m.pct !== null && <Progress pct={Math.min(100, m.pct)} tone={m.pct >= 95 ? "err" : m.pct >= 80 ? "warn" : undefined} />}
    </td>
  );
}

export function ExtraDbTable<T extends ExtraView>({ title, meta, rows, source, extraHead = [], extraCells }: {
  title: string; meta?: ReactNode; rows: T[]; source: string; extraHead?: string[]; extraCells?: (r: T) => ReactNode;
}) {
  const meterHead = rows[0]?.meters.map((m) => <span key={m.label}>{m.label}<Src kind="api">{source}</Src></span>) ?? [];
  return (
    <Card title={title} meta={meta} flush>
      <div className="overflow-x-auto">
        <table className={tableClass}>
          <TableHead head={["Database", "Account", "State", ...extraHead, ...meterHead, "As of", "Notes"]} />
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={cn(rowClass, r.stale && "opacity-60")}>
                <td className={td}>
                  <Resource kind="db" name={r.name} dbId={r.id} />
                  {r.sub && <div className={faint}>{r.sub}</div>}
                </td>
                <td className={td}><AccountChip name={r.account} /></td>
                <td className={td}><Status state={r.status.state}>{r.status.label}</Status></td>
                {extraCells?.(r)}
                {r.meters.map((m) => <MeterCell key={m.label} m={m} />)}
                <td className={cn(td, "text-ink-soft")}>{r.asOf ?? "—"}</td>
                <td className={cn(td, tdWrap, "text-[12.5px] text-ink-soft")}>
                  {r.note && <div>{r.note}</div>}
                  {r.usedBy.length > 0 && <div className={faint}>used by {r.usedBy.map((u, i) => <span key={u.id}>{i > 0 && ", "}<Resource kind="app" name={u.name} href={`/apps/${u.id}`} /></span>)}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
