import type { ReactNode } from "react";
import { UptimeBars } from "@/components/charts";
import { NoMonitors } from "@/components/empty-states";
import { Card, PageHeader, Tag } from "@/components/kit";
import { ListFilter } from "@/components/list-filter";
import { AutoRefresh } from "@/components/live";
import { ResourceBadge } from "@/components/resource";
import { Src } from "@/components/sources";
import { Status } from "@/components/status";
import { PlainTable } from "@/components/plain-table";
import { RefreshButton } from "@/components/refresh-button";
import { type ListRow, rowClass, td, tdWrap } from "@/components/table";
import { requirePageMember } from "@/lib/auth";
import { listWindows } from "@/lib/data/maintenance-db";
import { appOptions, listMonitors, type MonitorRow } from "@/lib/data/monitors-db";
import { publicMonitorIds } from "@/lib/data/public-status-db";
import { durationLabel } from "@/lib/heartbeat";
import { activeFor, windowText } from "@/lib/maintenance";
import { zoneSentence } from "@/lib/time";
import { cn } from "@/lib/utils";
import { pct } from "@/lib/view/format";
import { canAct, MONITOR_STATE_OPTIONS, monitorStatus } from "@/lib/view/labels";
import { summaryCounts, type SummaryCounts, uptimeBars } from "@/lib/view/uptime";
import { MaintenanceDialog, type TargetOptions } from "./maintenance-dialog";
import { MaintenanceMenu } from "./maintenance-menu";
import { MonitorDialog } from "./monitor-dialog";
import { MonitorMenu } from "./monitor-menu";
import { Masked, MaskedText } from "@/components/alias";

// Check now runs an HTTP check (up to 10 s) inside this page's server action.
export const maxDuration = 30;

const mono = "font-mono text-[12.5px]";
const HEAD: ReactNode[] = ["Monitor", "Status", <span key="bars">Last 90 days<Src kind="calc" /></span>, "Uptime", "Response", "Interval", ""];
// Paused (owner-paused or app not watched) is not in the mockup, but without it those monitors sit in no card.
const SUMMARY: [string, keyof SummaryCounts][] = [["Up", "ok"], ["Degraded", "warn"], ["Down", "err"], ["Maintenance", "maint"], ["Paused", "paused"]];
const MAINT_HEAD: ReactNode[] = ["Applies to", "When", "Note", "Status", ""];

// U3 (mockup): a heartbeat reads "{app} · {name}" with a Heartbeat tag and "{period} + {grace}" as its interval; an HTTP
// check with a body rule gets a Keyword tag whose title says what it looks for.
const isHeartbeat = (m: MonitorRow) => m.kind === "heartbeat";
const ruleText = (m: MonitorRow) => m.bodyContains ?? (m.jsonPath ? `JSON ${m.jsonPath} equals "${m.jsonEquals ?? ""}"` : null);
const intervalText = (m: MonitorRow) =>
  isHeartbeat(m) ? `${durationLabel(m.periodS ?? 3600)} + ${durationLabel(m.graceS ?? 600)}` : `${Math.max(1, Math.round(m.intervalS / 60))} min`;

export default async function UptimePage() {
  const member = await requirePageMember();
  const now = new Date();
  const act = canAct(member.role);
  const [mons, apps, windows, pub] = await Promise.all([listMonitors(now), act ? appOptions() : Promise.resolve([]), listWindows(), publicMonitorIds()]); // perf P4
  // U5 / B3: a monitor inside a maintenance window, heartbeats included, reads "Maintenance · until HH:MM" (WIB).
  const shown = mons.map((m) => ({ m, s: monitorStatus(m, activeFor(windows, { monitorId: m.id, appId: m.appId }, now), now) }));
  const counts = summaryCounts(shown.map(({ m, s }) => ({ state: s.state, appGone: m.appGone })));
  const rows: ListRow[] = shown.map(({ m, s }) => {
    const hb = isHeartbeat(m);
    const rule = hb ? null : ruleText(m);
    const name = hb ? `${m.appName} · ${m.path}` : `${m.appName}${m.path}`;
    return {
      key: m.id,
      state: s.state,
      text: [name, hb ? "Heartbeat" : rule ? "Keyword" : "", pub.has(m.id) ? "Public" : "", s.label, pct(m.uptime30)].join(" "),
      row: (
        <tr className={rowClass}>
          <td className={td}>
            <span className="inline-flex items-center gap-[7px]">
              <ResourceBadge kind="mon" />
              <span><Masked kind="app" real={m.appName} /><span className="text-ink-faint">{hb ? ` · ${m.path}` : m.path}</span></span>
              {hb && <Tag>Heartbeat</Tag>}
              {rule && <span title={rule}><Tag>Keyword</Tag></span>}
              {pub.has(m.id) && <span title="Shown on the public status page"><Tag>Public</Tag></span>}
            </span>
          </td>
          <td className={td}><Status state={s.state}>{s.label}</Status></td>
          <td className={td}><UptimeBars bars={uptimeBars(m.days, now)} /></td>
          <td className={cn(td, mono)}>{pct(m.uptime30)}</td>
          <td className={cn(td, mono)}>{hb || m.state === "err" || m.lastLatencyMs === null ? "—" : `${m.lastLatencyMs} ms`}</td>
          <td className={cn(td, "text-ink-soft")}>{intervalText(m)}</td>
          <td className={td}>
            {act && <MonitorMenu monitor={{
              id: m.id, appName: m.appName, path: m.path, url: m.url, expectedStatus: m.expectedStatus, timeoutMs: m.timeoutMs, bodyContains: m.bodyContains,
              jsonPath: m.jsonPath, jsonEquals: m.jsonEquals, ownerPaused: m.ownerPaused, kind: m.kind, name: m.name, periodS: m.periodS, graceS: m.graceS,
            }} />}
          </td>
        </tr>
      ),
    };
  });
  // The window dialog's monitor picker names a heartbeat "app · name", as listWindows() does.
  const options: TargetOptions = {
    apps: apps.map((a) => ({ id: a.id, name: a.name })),
    monitors: mons.filter((m) => !m.appGone).map((m) => ({ id: m.id, label: isHeartbeat(m) ? `${m.appName} · ${m.path}` : `${m.appName}${m.path}` })),
  };
  const maintRows: ListRow[] = windows.map((w) => {
    const t = windowText(w, now);
    return {
      key: w.id,
      state: t.status.state,
      text: [w.target, t.when, w.note ?? ""].join(" "),
      row: (
        <tr className={rowClass}>
          <td className={td}><MaskedText text={w.target} /></td>
          <td className={td}>{t.when}</td>
          <td className={cn(td, tdWrap, "text-ink-soft")}>{w.note ? <MaskedText text={w.note} /> : "—"}</td>
          <td className={td}><Status state={t.status.state}>{t.status.text}</Status></td>
          <td className={td}>{act && <MaintenanceMenu win={w} options={options} />}</td>
        </tr>
      ),
    };
  });

  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader
        crumbs={[{ label: "Hosting" }, { label: "Uptime" }]}
        title="Uptime"
        sub="HTTP checks run every minute; heartbeats wait for your own jobs to ping. cron-job.org calls the collector, and Upstash QStash checks every 5 minutes that it is still running."
        actions={act ? <><RefreshButton /><MaintenanceDialog mode="add" options={options} /><MonitorDialog mode="add" apps={apps} /></> : undefined}
      />
      <div className="grid grid-cols-1 gap-4 min-[721px]:grid-cols-2 min-[1281px]:grid-cols-5">
        {SUMMARY.map(([title, key]) => (
          <Card key={title} title={title}>
            <span className="text-[26px] font-semibold tracking-[-0.02em]">{counts[key]}</span>
          </Card>
        ))}
      </div>
      <Card flush>
        {mons.length === 0
          ? <NoMonitors canAct={act} />
          : <ListFilter placeholder="Filter by name" states={MONITOR_STATE_OPTIONS} head={HEAD} rows={rows} />}
      </Card>
      <Card title="Maintenance windows" flush>
        <p className="mx-[18px] mb-2.5 text-[12.5px] text-ink-soft">Checks keep running inside a window, but they are left out of uptime % and open no alerts. {zoneSentence()}</p>
        {maintRows.length
          ? <PlainTable head={MAINT_HEAD} rows={maintRows} />
          : <p className="mx-[18px] mb-4 text-[13px] text-ink-faint">No maintenance windows.{act ? " Add one before planned work, so it doesn't count as downtime." : ""}</p>}
      </Card>
    </>
  );
}
