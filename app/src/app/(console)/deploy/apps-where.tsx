import Link from "next/link";
import { Masked } from "@/components/alias";
import { Card } from "@/components/kit";
import { Status } from "@/components/status";
import { rowClass, td, tableClass, TableHead } from "@/components/table";
import type { State } from "@/lib/status";

// Mockup view "hosting", panel "Apps": every watched application and where it runs. Today that is the synced Vercel
// projects; other hosts join when Watchbell syncs them as applications. Names, domains and the team are masked in
// screenshot mode like everywhere else (review I5).
export type WhereRow = { id: string; name: string; domain: string; runsOn: string; detail: string | null; state: State; label: string };

export function AppsWhere({ rows }: { rows: WhereRow[] }) {
  return (
    <Card title="Where your apps run" meta={rows.length ? `${rows.length}` : undefined} flush>
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <TableHead head={["App", "Runs on", "State"]} />
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={rowClass}>
                  <td className={td}>
                    <Link href={`/apps/${r.id}`} className="font-medium hover:underline"><Masked kind="app" real={r.name} inLink /></Link>
                    {r.domain && <div className="font-mono text-[12px] text-ink-faint"><Masked kind="text" real={r.domain} /></div>}
                  </td>
                  <td className={td}>{r.runsOn}{r.detail && <div className="text-[12px] text-ink-faint"><Masked kind="account" real={r.detail} /></div>}</td>
                  <td className={td}><Status state={r.state}>{r.label}</Status></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-[18px] pb-4 text-ink-soft">No applications watched yet. Deploy one above, then tick it under Sync on Connections.</p>
      )}
    </Card>
  );
}
