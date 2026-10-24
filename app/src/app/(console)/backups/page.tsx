import { IconExternalLink } from "@tabler/icons-react";
import { Banner, buttonClass, Card, EmptyState, PageHeader } from "@/components/kit";
import { NoAccess } from "@/components/no-access";
import { Status } from "@/components/status";
import { td, tableClass, TableHead, tdWrap } from "@/components/table";
import { pageGate } from "@/lib/auth";
import { folderLabel, monthLabel, monthOf, nextBackupMonth } from "@/lib/backup/content";
import { CALLBACK_TEXT, isCallbackCode } from "@/lib/backup/connect";
import { folderUrl } from "@/lib/backup/drive";
import { driveEnv } from "@/lib/backup/google-oauth";
import { driveStatus, listBackups, readFolder } from "@/lib/data/backup-db";
import { cn } from "@/lib/utils";
import { backupRows, driveState, KEEP_TEXT, WHATS_INSIDE } from "@/lib/view/backups";
import { BackUpNowButton } from "./drive-buttons";
import { DriveStateBlock } from "./drive-card";

// "Back up now" runs a whole backup as this page's server action (stops starting calls after 45 s).
export const maxDuration = 60;

const ROW = "grid grid-cols-[260px_minmax(0,1fr)] items-center gap-4 border-b border-line py-2.5 last:border-b-0 max-[720px]:grid-cols-1 max-[720px]:gap-1";
const metric = "text-[20px] font-semibold tracking-[-0.02em]";
const sub = "mt-1 text-[12.5px] text-ink-soft";

export default async function BackupsPage({ searchParams }: { searchParams: Promise<{ drive?: string }> }) {
  const gate = await pageGate("owner");
  if (!gate.ok) return <NoAccess role={gate.member.role} />;
  const now = new Date();
  const [{ drive: result }, account, rows, folder] = await Promise.all([searchParams, driveStatus(), listBackups(), readFolder()]);
  const state = driveState(driveEnv() !== null, account);
  const views = backupRows(rows);
  const next = nextBackupMonth(rows, now);
  const banner = isCallbackCode(result) ? CALLBACK_TEXT[result] : null;
  const connected = state.kind === "ok" || state.kind === "problem";

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Manage" }, { label: "Backups" }]}
        title="Backups"
        sub="A summary of every month is saved to your Google Drive automatically. Backups older than 3 months are moved to Drive trash, and Drive deletes them for good 30 days later."
        actions={<BackUpNowButton monthLabel={monthLabel(monthOf(now)).split(" ")[0]} disabled={!connected} />}
      />
      {banner && <Banner tone={banner.tone === "ok" ? "info" : "danger"} title={banner.text} />}
      <div className="grid grid-cols-1 gap-4 min-[721px]:grid-cols-2 min-[1101px]:grid-cols-4">
        <Card title="Google Drive"><DriveStateBlock state={state} folderName={folderLabel(folder)} /></Card>
        <Card title="Next backup">
          <span className={metric}>{next.date ?? next.runsOn}</span>
          <p className={sub}>Covers {next.covers} · {next.at}, with the daily job</p>
        </Card>
        <Card title="Keep"><span className={metric}>{KEEP_TEXT}</span><p className={sub}>Then moved to trash</p></Card>
        <Card title="Drive access"><span className={cn(metric, "font-mono text-[18px]")}>drive.file</span><p className={sub}>Can&apos;t see your other files</p></Card>
      </div>
      <Card title="Monthly backups" flush meta={folder && connected ? <a href={folderUrl(folder.id)} target="_blank" rel="noopener" className="inline-flex items-center gap-1">Open folder <IconExternalLink size={13} aria-hidden /></a> : undefined}>
        {views.length === 0 ? (
          <div className="border-t border-line">
            <EmptyState title="No backups yet">{connected ? "The first one is written on the 1st, or press Back up now." : "Connect Google Drive to start."}</EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <TableHead head={["Month", "Files", "Size", "Created", "Status", ""]} />
              <tbody>
                {views.map((b) => (
                  <tr key={b.month} className="hover:bg-hover">
                    <td className={td}><b className="font-medium">{b.label}</b></td>
                    <td className={td}>
                      <span className="mr-1.5 rounded-[5px] border border-line bg-surface-2 px-1.5 text-xs text-ink-soft">Summary sheet</span>
                      <span className="rounded-[5px] border border-line bg-surface-2 px-1.5 text-xs text-ink-soft">Raw data .csv.gz</span>
                    </td>
                    <td className={`${td} font-mono text-[12.5px]`}>{b.size}</td>
                    <td className={`${td} text-ink-soft`}>{b.created}</td>
                    <td className={cn(td, tdWrap)}>
                      <Status state={b.state}>{b.status}</Status>
                      {b.note && <div className="mt-0.5 text-[12px] text-ink-soft">{b.note}</div>}
                    </td>
                    <td className={td}>
                      <div className="flex gap-1.5">
                        {b.sheet && <a className={buttonClass({ size: "sm" })} href={b.sheet} target="_blank" rel="noopener">Open in Drive</a>}
                        {b.download && <a className={buttonClass({ size: "sm" })} href={b.download} target="_blank" rel="noopener">Download</a>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="What's in each backup">
        {WHATS_INSIDE.map(([t, d]) => (
          <div key={t} className={ROW}><span className="font-medium">{t}</span><span className="text-ink-soft">{d}</span></div>
        ))}
        <p className="pt-2.5 text-[12.5px] text-ink-soft">Databases appear by their alias (db-a, db-b…) and emails are hidden, as everywhere in the console.</p>
      </Card>
    </>
  );
}
