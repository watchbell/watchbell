import { PageHeader } from "@/components/kit";
import { requirePageMember } from "@/lib/auth";
import { readChannel } from "@/lib/data/notify-db";
import { listReports, reportMonitorOptions, reportMonths } from "@/lib/data/report-db";
import { notifyEnv } from "@/lib/notify/env";
import { timeZone } from "@/lib/time";
import { zoneDay } from "@/lib/zone-day";
import { ReportsView } from "./reports-view";
import { currentWorkspace, workspaceForEditing } from "@/lib/workspace/current";

// Watchbell 1.7 (spec §2.1): Manage › Reports, for every member. Viewers get the list without recipients (personal
// data); the editor's monitor list and the senders are read only for those who can use them.

const monthLabel = (m: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-15T12:00:00Z`));

export default async function ReportsPage() {
  const member = await requirePageMember();
  const role = member.role;
  const zone = timeZone();
  const now = new Date();
  const editor = role !== "viewer";
  // 1.8: the workspace's reports; a new report and its website picker belong to the workspace shown (or the default).
  const [ws, editing] = await Promise.all([currentWorkspace(), workspaceForEditing()]);
  const [reports, finished, monitors, smtp] = await Promise.all([
    listReports(ws.id), reportMonths(now, zone), editor ? reportMonitorOptions(editing) : Promise.resolve([]), role === "owner" ? readChannel("smtp").catch(() => null) : Promise.resolve(null),
  ]);
  const current = zoneDay(now, zone).slice(0, 7);
  const months = [...finished.map((m) => ({ value: m, label: monthLabel(m) })), { value: current, label: `${monthLabel(current)} (so far)` }];
  const env = notifyEnv();
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Manage" }, { label: "Reports" }]} title="Reports"
        sub="A monthly two-page PDF per client: uptime as a calendar, incidents in plain words, response times and updates. Download it, or have it emailed on the 1st."
      />
      <div className="mt-3.5">
        <ReportsView
          role={role}
          reports={role === "viewer" ? reports.map((r) => ({ ...r, recipients: [] })) : reports}
          months={months}
          monitors={monitors}
          senders={{ smtp: Boolean(smtp?.row.enabled && smtp.config?.host), resend: Boolean(env.resendKey && env.digestFrom) }}
        />
      </div>
    </>
  );
}
