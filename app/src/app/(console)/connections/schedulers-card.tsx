import { desc, eq } from "drizzle-orm";
import type { ReactNode } from "react";
import { Card } from "@/components/kit";
import { Status } from "@/components/status";
import { db } from "@/db/client";
import { collectorRuns, settings } from "@/db/schema";
import { schedulerRun } from "@/lib/collector/status";
import { ago } from "@/lib/time";

const runStatus = (run: Parameters<typeof schedulerRun>[0], now: Date, lateMs: number) => {
  const r = schedulerRun(run, now, lateMs);
  return <Status state={r.state}>{r.text}</Status>;
};

async function lastRun(trigger: "cron_job_org" | "vercel_cron") {
  const [r] = await db().select().from(collectorRuns).where(eq(collectorRuns.trigger, trigger)).orderBy(desc(collectorRuns.startedAt)).limit(1);
  return r ?? null;
}

export async function SchedulersCard() {
  const now = new Date();
  const [cron, daily, ping] = await Promise.all([
    lastRun("cron_job_org"),
    lastRun("vercel_cron"),
    db().select().from(settings).where(eq(settings.key, "watchdog.lastPing")).limit(1).then((r) => r[0] ?? null),
  ]);
  const pingAt = ping ? new Date(String((ping.value as { at?: string }).at)) : null;
  const rows: { name: string; help: string; status: ReactNode }[] = [
    {
      name: "cron-job.org",
      help: "Calls /api/collect every minute with a secret header.",
      status: !cron ? <Status state="idle">Not set up yet</Status>
        : runStatus(cron, now, 3 * 60_000),
    },
    {
      name: "Upstash QStash",
      help: "Watchdog every 5 minutes. Alerts if the collector stops.",
      status: !pingAt ? <Status state="idle">Not set up yet</Status>
        : <Status state={now.getTime() - pingAt.getTime() < 12 * 60_000 ? "ok" : "warn"}>Last run {ago(pingAt, now)}</Status>,
    },
    {
      name: "Vercel Cron",
      help: "Daily at 03:00: rollups, DB sizes, TLS, domain expiry, and a sync of every account. On the 1st it also writes the monthly backup.",
      status: !daily ? <Status state="idle">Not run yet</Status>
        : runStatus(daily, now, 26 * 3_600_000),
    },
  ];
  return (
    <Card title="Schedulers">
      <div className="divide-y divide-line">
        {rows.map((r) => (
          <div key={r.name} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
            <div>
              <div className="font-medium">{r.name}</div>
              <div className="text-[12.5px] text-ink-soft">{r.help}</div>
            </div>
            {r.status}
          </div>
        ))}
      </div>
    </Card>
  );
}
