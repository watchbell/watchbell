import { desc } from "drizzle-orm";
import Link from "next/link";
import { MaskedText } from "@/components/alias";
import { buttonClass, Card } from "@/components/kit";
import { Status } from "@/components/status";
import { td, tableClass, TableHead } from "@/components/table";
import { db } from "@/db/client";
import { collectorRuns } from "@/db/schema";
import { aliasBook } from "@/lib/data/cached";
import { EMPTY_BOOK, hideNames } from "@/lib/view/display-name";
import { zoneName } from "@/lib/time";
import { runRows, taskScheduleRows, zoneSetting } from "@/lib/view/settings";
import { SchedulersCard } from "../connections/schedulers-card";

// Read-only. The scheduler health is the same card Connections shows; nothing here writes.
export async function CollectorTab() {
  const runs = await db().select({
    id: collectorRuns.id, startedAt: collectorRuns.startedAt, trigger: collectorRuns.trigger, tasks: collectorRuns.tasks,
    ok: collectorRuns.ok, errorSummary: collectorRuns.errorSummary, durationMs: collectorRuns.durationMs,
  }).from(collectorRuns).orderBy(desc(collectorRuns.startedAt)).limit(20);
  // M8: database names in the error lines become their aliases (always), and screenshot mode masks the rest.
  const book = await aliasBook().catch(() => EMPTY_BOOK);
  const rows = runRows(runs, (t) => hideNames(t, book));
  const zone = zoneSetting();
  return (
    <div className="flex flex-col gap-4">
      <SchedulersCard />
      <Card title="What runs when" flush meta="Per run, a task starts only when its interval has passed">
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <TableHead head={["Task", "Runs"]} />
            <tbody>
              {taskScheduleRows().map((r) => (
                <tr key={r.task}>
                  <td className={td}>{r.label} <span className="ml-1 font-mono text-xs text-ink-soft">{r.task}</span></td>
                  <td className={`${td} text-ink-soft`}>{r.every}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Stage 6 (mockup Settings → Collector): keep-alive is set per project on the Supabase page. */}
        <div className="grid grid-cols-[260px_minmax(0,1fr)] items-center gap-4 border-t border-line px-[18px] py-3 max-[720px]:grid-cols-1 max-[720px]:gap-1">
          <div className="font-medium">
            Keep Supabase projects awake
            <span className="mt-0.5 block text-[12.5px] font-normal text-ink-soft">Off by default. Set per project on the Supabase page (Keep active, Auto-restore; owner only). Not offered for Neon, because staying awake would use up its CU-hours.</span>
          </div>
          <span><Link href="/supabase" className={buttonClass({ size: "sm" })}>Open Supabase</Link></span>
        </div>
        {/* 1.1 (D1): read-only; the zone comes from the environment, so it is changed there and Watchbell restarted. */}
        <div className="grid grid-cols-[260px_minmax(0,1fr)] items-center gap-4 border-t border-line px-[18px] py-3 max-[720px]:grid-cols-1 max-[720px]:gap-1">
          <div className="font-medium">
            Time zone
            <span className="mt-0.5 block text-[12.5px] font-normal text-ink-soft">{zone.follows}</span>
          </div>
          <span className="text-ink-soft">{zone.text}</span>
        </div>
      </Card>
      <Card title="Last 20 runs" flush meta={`Times in ${zoneName()}`}>
        {rows.length === 0 ? (
          <p className="px-[18px] pb-4 text-ink-soft">The collector hasn&apos;t run yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <TableHead head={["Started", "Trigger", "Tasks", "Duration", "Result"]} />
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className={`${td} font-mono text-[12.5px]`}>{r.at}</td>
                    <td className={td}>{r.trigger}</td>
                    <td className={td}>{r.tasks}</td>
                    <td className={`${td} font-mono text-[12.5px]`}>{r.duration}</td>
                    <td className={td}><Status state={r.ok === null ? "build" : r.ok ? "ok" : "warn"}><MaskedText text={r.summary} /></Status></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
