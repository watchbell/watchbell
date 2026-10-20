import { IconBolt } from "@tabler/icons-react";
import Link from "next/link";
import { Masked } from "@/components/alias";
import { buttonClass, Card, EmptyState, PageHeader, Progress } from "@/components/kit";
import { ListFilter } from "@/components/list-filter";
import { AutoRefresh } from "@/components/live";
import { AccountChip, Resource } from "@/components/resource";
import { Src } from "@/components/sources";
import { Status } from "@/components/status";
import { rowClass, td, tdWrap } from "@/components/table";
import { requirePageMember } from "@/lib/auth";
import { aliasBook, listDatabases, supabaseSlotInputs } from "@/lib/data/cached";
import { keepActiveFlags } from "@/lib/data/keep-active-db";
import { poolUsage } from "@/lib/data/pool-guard";
import { outboundLinks } from "@/lib/demo/links";
import { isCloud } from "@/lib/mode";
import { PoolCard } from "@/components/pool-card";
import { sqlConnectedIds } from "@/lib/data/sql-db";
import { readCompute } from "@/lib/data/supabase-metrics-db";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import { SqlAccessButtons } from "../sql/sql-access-dialog";
import { slotCards, storageTotal, supabaseRows } from "@/lib/view/databases";
import { hideEmails, searchText } from "@/lib/view/display-name";
import { actionsLabel, canAct } from "@/lib/view/labels";
import { computePanel } from "@/lib/view/usage";
import { type ComputeBlock, ComputeCard } from "./compute-panel";
import { CreateButton } from "@/components/create/create-dialog";
import { PendingCreates } from "@/components/create/pending-creates";
import { ActiveRowMenu, KeepActiveBoxes, type PauseChoice, RestoreButton } from "./row-actions";

// The SQL access dialog's automatic setup (slice 2b) runs as a server action of this page: two API calls, then up to
// three save-time checks a few seconds apart.
export const maxDuration = 60;

const faint = "text-[12px] text-ink-faint";

export default async function SupabasePage({ searchParams }: { searchParams: Promise<{ create?: string }> }) {
  const member = await requirePageMember();
  const { create } = await searchParams;
  const now = new Date();
  const act = canAct(member.role);
  const [rows, inputs, book] = await Promise.all([listDatabases("supabase_project"), supabaseSlotInputs(), aliasBook()]);
  const view = supabaseRows(rows, now, book);
  const slots = slotCards(inputs);
  const storage = storageTotal(view);
  const owner = member.role === "owner";
  const [flags, compute, sqlIds, pool] = await Promise.all([
    keepActiveFlags(view.map((v) => v.id)), readCompute(view.map((v) => v.id), now), owner ? sqlConnectedIds(view.map((v) => v.id)) : new Set<string>(),
    isCloud() ? poolUsage() : Promise.resolve(null),
  ]);
  // Stage 12: the Compute panel; a project shows in it when it has a key, or always for the owner (to add one).
  const blocks: ComputeBlock[] = view.filter((v) => owner || compute.has(v.id))
    .map((v) => ({ id: v.id, name: v.name, alias: v.alias, ref: v.ref, paused: v.paused, panel: computePanel(compute.get(v.id), now) }));
  // Mockup restoreDlg: without a free slot, Restore offers the account's active projects (the watched ones) to pause first.
  const choices = (account: string): PauseChoice[] => {
    const ids = new Set(slots.find((s) => s.account === account)?.activeIds ?? []);
    return view.filter((v) => ids.has(v.id) && !v.paused).map((v) => ({ id: v.id, ref: v.ref, alias: v.alias, traffic: v.traffic, usedBy: v.usedBy.map((u) => u.name) }));
  };
  const keepCell = (id: string) => {
    const f = flags.get(id);
    return { keep: f?.keep ?? false, autoRestore: f?.autoRestore ?? false, sent: f?.keep && f.lastKeepAliveAt ? ago(f.lastKeepAliveAt, now) : null };
  };
  const slotsLeft = (account: string) => slots.find((s) => s.account === account)?.left ?? 1;
  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader
        crumbs={[{ label: "Databases" }, { label: "Supabase" }]}
        title="Supabase"
        sub="Status comes from the Management API, which doesn't touch your database. Database size is read once a day, and only while a project is already active. Keep active (owner, per project): warns from day 5 without API traffic and sends one keep-alive query a day. Auto-restore brings a paused project back only when its account has a free slot."
        actions={member.role === "owner" ? <><Link href="/connections" className={buttonClass()}>Manage accounts</Link><CreateButton type="supabase_project" target="" targetName="Supabase" label="New project" /></> : undefined}
      />
      {/* Stage 6 create requests: new projects waiting for the owner's approval. */}
      <PendingCreates member={member} types={["supabase_project"]} focus={create ?? null} />
      {slots.length > 0 && (
        <div className="grid grid-cols-1 gap-4 min-[1001px]:grid-cols-3">
          {slots.map((s) => (
            <Card key={s.account} title={<>Account <Masked kind="account" real={s.account} /></>}>
              <span className="text-[26px] font-semibold tracking-tight">{s.used}<small className="ml-1 text-[13px] font-normal text-ink-soft">of {s.total} free slots</small></span>
              <Progress pct={(Math.min(s.used, s.total) / s.total) * 100} tone={s.left === 0 ? "warn" : undefined} />
              <p className="mt-2 text-[12.5px] text-ink-soft">Paused projects don&apos;t use a slot. Counted from the projects this token can see{s.planUnknown ? "; plan unknown, counted as free" : ""}.</p>
            </Card>
          ))}
          {pool && <PoolCard pool={pool} owner={owner} />}
          <Card title="Storage">
            <span className="text-[26px] font-semibold tracking-tight">{storage.text}<small className="ml-1 text-[13px] font-normal text-ink-soft">across {storage.count} project{storage.count === 1 ? "" : "s"}</small></span>
            <p className="mt-2 text-[12.5px] text-ink-soft">Free limit is 500 MB per project.</p>
          </Card>
        </div>
      )}
      <Card flush>
        {view.length === 0 ? (
          <EmptyState icon={IconBolt} title="No Supabase projects watched yet"
            action={member.role === "owner" ? <Link href="/connections" className={buttonClass({ size: "sm" })}>Open connections</Link> : undefined}>
            {member.role === "owner" ? "Connect a Supabase account, then press Sync and tick the projects to watch." : "An owner picks the projects to watch in Connections."}
          </EmptyState>
        ) : (
          <ListFilter
            placeholder="Filter by name"
            states={[["ok", "Active"], ["paused", "Paused"]]}
            groups={[...new Set(view.map((v) => v.account))].sort()}
            head={["Project", "Account", <span key="s">Status<Src kind="api" /></span>, <span key="z">Database size<Src kind="api">API · daily</Src></span>,
              <span key="t">Last API traffic<Src kind="api" /></span>, <span key="r">Auto-pause risk<Src kind="calc" /></span>, "Used by",
              <span key="k">Keep active<Src kind="calc">Owner</Src></span>, ""]}
            rows={view.map((v) => ({
              key: v.id, state: v.status.state, group: v.account,
              // The filter finds a project by its alias or its real name (privacy).
              text: searchText([v.alias, hideEmails(v.account), v.status.label, v.risk.text, ...v.usedBy.map((u) => u.name)], [v.name, v.account]),
              row: (
                <tr className={cn(rowClass, v.stale && "opacity-60")}>
                  <td className={td}><Resource kind="db" name={v.name} dbId={v.id} /><div className={faint}>{v.sub}</div></td>
                  <td className={td}><AccountChip name={v.account} /></td>
                  <td className={td}><Status state={v.status.state}>{v.status.label}</Status>{v.since && <div className={faint}>since {v.since}</div>}</td>
                  <td className={td}>
                    {v.size ? <><span className="font-mono">{v.size.text}</span> <span className="text-ink-faint">/ 500 MB</span><Progress pct={v.size.pct} tone={v.size.pct >= 80 ? "warn" : undefined} /><div className={faint}>as of {v.size.asOf}</div></>
                      : <span className={cn(faint, "whitespace-normal")}>{v.sizeNote}</span>}
                  </td>
                  <td className={cn(td, "text-ink-soft")} title={v.trafficNote ?? undefined}>{v.traffic}</td>
                  <td className={cn(td, tdWrap)}><Status state={v.risk.state}>{v.risk.text}</Status>{v.risk.note && <div className={faint}>{v.risk.note}</div>}</td>
                  <td className={td}>{v.usedBy.length ? v.usedBy.map((u) => <div key={u.id}><Resource kind="app" name={u.name} href={`/apps/${u.id}`} /></div>) : <span className="text-ink-faint">Not linked</span>}</td>
                  <td className={cn(td, tdWrap)}>
                    <KeepActiveBoxes id={v.id} alias={v.alias} owner={owner} {...keepCell(v.id)} />
                  </td>
                  <td className={td}>
                    {/* Stage 9 slice 2: the owner's read-only connection for the SQL console. */}
                    {owner && !v.paused && <div className="mb-1"><SqlAccessButtons id={v.id} alias={v.alias} provider="supabase" connected={sqlIds.has(v.id)} /></div>}
                    {act && (v.paused
                      ? <RestoreButton id={v.id} projectRef={v.ref} alias={v.alias} account={v.account} slotsLeft={slotsLeft(v.account)} choices={choices(v.account)} />
                      : <ActiveRowMenu id={v.id} projectRef={v.ref} alias={v.alias} label={actionsLabel(v.alias)} metrics={owner ? { hasKey: compute.has(v.id) } : undefined} dashboard={outboundLinks()} />)}
                  </td>
                </tr>
              ),
            }))}
          />
        )}
      </Card>
      <ComputeCard blocks={blocks} owner={owner} />
    </>
  );
}
