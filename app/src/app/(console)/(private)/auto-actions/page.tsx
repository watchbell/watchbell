import Link from "next/link";
import { MaskedText } from "@/components/alias";
import { Banner, buttonClass, Card, EmptyState, PageHeader, Tag } from "@/components/kit";
import { AutoRefresh } from "@/components/live";
import { NoAccess } from "@/components/no-access";
import { Status } from "@/components/status";
import { rowClass, tableClass, TableHead, td, tdWrap } from "@/components/table";
import { pageGate } from "@/lib/auth";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import { AREA_LABELS } from "@/private/actions/areas";
import { DecideForm } from "@/private/actions/decide-form";
import { isProposalId } from "@/private/actions/proposals";
import { listProposals, readProposal } from "@/private/actions/proposals-db";
import { ACTION_KINDS, readAutoRun } from "@/private/actions/proposals-settings";
import type { Proposal } from "@/private/actions/proposals-types";
import { proposalsView, statusState } from "@/private/actions/proposals-view";

// Auto-actions (open source v1, task 4): the console's own page for the actions proposed for firing alerts, so they
// don't need the Virtual Office. Waiting ones are approved or rejected here (the same decide path as the office and the
// Telegram buttons); History shows the last ones with their result. ?proposal=<id> (the Telegram link) marks that row,
// read on its own when it is older than the list.
const SETTINGS_HREF = "/settings?tab=office-auto-run";
const HISTORY_LIMIT = 50;
const HEAD = ["Proposal", "Status", "Result", "Decided by", "When"];
// An approval runs the action inside the Server Action (a Vercel or Supabase call takes a few seconds).
export const maxDuration = 60;

export default async function AutoActionsPage({ searchParams }: { searchParams: Promise<{ proposal?: string | string[] }> }) {
  const gate = await pageGate("owner"); // R2, again here: a layout doesn't stop its page from running
  if (!gate.ok) return <NoAccess role={gate.member.role} />;
  const now = new Date();
  const { proposal } = await searchParams;
  const focusId = isProposalId(proposal) ? proposal : null;
  const [list, autoRun] = await Promise.all([listProposals(now, HISTORY_LIMIT), readAutoRun()]);
  const extra = focusId && !list.some((p) => p.id === focusId) ? await readProposal(focusId) : null;
  const { pending, history, focus } = proposalsView(extra ? [...list, extra] : list, focusId);
  const autoOn = ACTION_KINDS.filter((k) => autoRun[k]).length;

  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader
        crumbs={[{ label: "Automation" }, { label: "Auto-actions" }]}
        title="Auto-actions"
        sub="Console actions proposed for firing alerts. Approve runs the console's own action with you as the actor, and every run is in Events. Risky actions always wait for you."
        actions={
          <Link href={SETTINGS_HREF} className={buttonClass()}>
            Settings › Auto-actions
          </Link>
        }
      />
      <p className="text-[13px] text-ink-soft">
        Auto-run is {autoOn ? `on for ${autoOn} safe kind${autoOn === 1 ? "" : "s"}` : "off for every kind"}.
      </p>
      {focusId && !focus && <Banner tone="info" title="That proposal is gone">Proposals are kept 30 days.</Banner>}

      <Card title="Waiting for you" meta={pending.length ? `${pending.length} waiting` : undefined} flush>
        {pending.length === 0 ? (
          <EmptyState title="Nothing waits for you">New proposals appear here when an alert fires.</EmptyState>
        ) : (
          <ul className="border-t border-line">
            {pending.map((p) => (
              <li key={p.id} id={`proposal-${p.id}`} className={cn("border-b border-line px-[18px] py-3 last:border-b-0", p.id === focusId && "border-l-[3px] border-l-brand bg-brand-soft/40")}>
                <div className="flex flex-wrap items-center gap-2">
                  <b className="font-medium"><MaskedText text={p.title} /></b>
                  <RiskChip risk={p.risk} />
                </div>
                <p className="mt-0.5 text-ink-soft"><MaskedText text={p.reason} /></p>
                <p className="mt-0.5 text-[12.5px] text-ink-faint">
                  {AREA_LABELS[p.room]} · {p.actionLabel} · proposed {ago(new Date(p.createdAt), now)}
                </p>
                <div className="mt-2"><DecideForm id={p.id} /></div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="History" meta="Recent decisions" flush>
        {history.length === 0 ? (
          <EmptyState title="No decisions yet">Approved, rejected, expired and auto-run proposals are listed here.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <TableHead head={HEAD} />
              <tbody>{history.map((p) => <HistoryRow key={p.id} p={p} focused={p.id === focusId} now={now} />)}</tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function RiskChip({ risk }: { risk: Proposal["risk"] }) {
  return (
    <span className={cn("rounded border px-1.5 py-px text-[11.5px]", risk === "risky" ? "border-warn-icon/40 bg-warn-soft text-warn" : "border-transparent bg-ok-soft text-ok")}>
      {risk}
    </span>
  );
}

function HistoryRow({ p, focused, now }: { p: Proposal; focused: boolean; now: Date }) {
  return (
    <tr id={`proposal-${p.id}`} className={cn(rowClass, focused && "bg-brand-soft/40 [&>td:first-child]:border-l-[3px] [&>td:first-child]:border-l-brand")}>
      <td className={cn(td, tdWrap)}>
        <b className="block font-medium"><MaskedText text={p.title} /></b>
        <span className="text-[12.5px] text-ink-soft">{AREA_LABELS[p.room]} · {p.risk}</span>
      </td>
      <td className={td}><Status state={statusState(p.status)}>{p.status}</Status></td>
      <td className={cn(td, tdWrap, "text-ink-soft")}>{p.result ? <MaskedText text={p.result} /> : "—"}</td>
      <td className={td}>{p.auto ? <Tag>Auto</Tag> : p.status === "expired" ? "—" : "Owner"}</td>
      <td className={cn(td, "text-ink-soft")}>{ago(new Date(p.decidedAt ?? p.createdAt), now)}</td>
    </tr>
  );
}
