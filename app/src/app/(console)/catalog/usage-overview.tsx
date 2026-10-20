import Link from "next/link";
import { Card, Progress } from "@/components/kit";
import { Resource } from "@/components/resource";
import { Src } from "@/components/sources";
import { Status } from "@/components/status";
import { rowClass, tableClass, TableHead, td, tdWrap } from "@/components/table";
import { aliasBook, listDatabases } from "@/lib/data/cached";
import { readCompute } from "@/lib/data/supabase-metrics-db";
import { cn } from "@/lib/utils";
import { type UsageSource, usageRows } from "@/lib/view/usage";

// Stage 12: one row per watched database, the highest share of its free-plan quota (or compute) with where the
// number comes from and when. The page checked membership before rendering this (server component, no input).
const SOURCE: Record<UsageSource, { kind: "api"; text: string }> = {
  metrics: { kind: "api", text: "Metrics API" },
  api: { kind: "api", text: "API" },
  monitoring: { kind: "api", text: "Cloud Monitoring" },
  graphql: { kind: "api", text: "GraphQL analytics" },
};
const faint = "text-[12px] text-ink-faint";

export async function UsageOverview() {
  const now = new Date();
  const [supabase, neon, firestore, turso, upstash, d1, book] = await Promise.all([
    listDatabases("supabase_project"), listDatabases("neon_project"), listDatabases("firestore"),
    listDatabases("turso_database"), listDatabases("upstash_redis"), listDatabases("d1_database"), aliasBook(),
  ]);
  if (![supabase, neon, firestore, turso, upstash, d1].some((x) => x.length)) return null;
  const compute = await readCompute(supabase.map((r) => r.id), now);
  const rows = usageRows({ supabase, neon, firestore, compute, turso, upstash, d1 }, now, book);
  return (
    <Card title="Your databases" meta="Highest share of the free plan used" flush>
      <div className="overflow-x-auto">
        <table className={tableClass}>
          <TableHead head={["Database", "Provider", "Most used", "Source", "As of", "Other"]} />
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={rowClass}>
                <td className={td}><Resource kind={r.provider === "Firestore" ? "fs" : "db"} name={r.name} dbId={r.id} /></td>
                <td className={td}><Link href={r.href} className="text-brand hover:underline">{r.provider}</Link></td>
                <td className={td}>
                  {r.main ? (
                    <>
                      <span className="text-[13px]">{r.main.label}</span>{" "}
                      <span className="font-mono">{Math.round(r.main.pct ?? 0)}%</span> <span className="text-ink-faint">{r.main.text}</span>
                      <Progress pct={r.main.pct ?? 0} tone={(r.main.pct ?? 0) >= 95 ? "err" : (r.main.pct ?? 0) >= 80 ? "warn" : undefined} />
                    </>
                  ) : <Status state="unknown">Not read</Status>}
                </td>
                <td className={td}><Src kind={SOURCE[r.source].kind}>{SOURCE[r.source].text}</Src></td>
                <td className={cn(td, "text-ink-soft")}>{r.asOf ?? "—"}</td>
                <td className={cn(td, tdWrap, "text-[12.5px] text-ink-soft")}>
                  {r.extra.length > 0 && <div>{r.extra.join(" · ")}</div>}
                  {r.note && <div className={faint}>{r.note}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
