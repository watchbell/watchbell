import { IconDatabase } from "@tabler/icons-react";
import Link from "next/link";
import { Banner, buttonClass, Card, EmptyState, PageHeader, Progress, Tag } from "@/components/kit";
import { AutoRefresh } from "@/components/live";
import { PlainTable } from "@/components/plain-table";
import { AccountChip, Resource } from "@/components/resource";
import { Src } from "@/components/sources";
import { Status } from "@/components/status";
import { rowClass, td } from "@/components/table";
import { requirePageMember } from "@/lib/auth";
import { aliasBook, listDatabases } from "@/lib/data/cached";
import { sqlConnectedIds } from "@/lib/data/sql-db";
import { NEON_FREE } from "@/lib/databases/neon";
import { cn } from "@/lib/utils";
import { neonBlocks } from "@/lib/view/databases";
import { rel } from "@/lib/view/format";
import { canAct } from "@/lib/view/labels";
import { wakeAction } from "./actions";
import { SqlAccessButtons } from "../sql/sql-access-dialog";
import { WakeButton } from "./wake-button";
import { CreateButton } from "@/components/create/create-dialog";
import { PendingCreates } from "@/components/create/pending-creates";

const metric = "text-[26px] font-semibold tracking-tight";
const small = "ml-1 text-[13px] font-normal text-ink-soft";

export default async function NeonPage({ searchParams }: { searchParams: Promise<{ create?: string }> }) {
  const member = await requirePageMember();
  const { create } = await searchParams;
  const now = new Date();
  const act = canAct(member.role);
  const [rows, book] = await Promise.all([listDatabases("neon_project"), aliasBook()]);
  const blocks = neonBlocks(rows, now, book);
  const owner = member.role === "owner";
  const sqlIds = owner ? await sqlConnectedIds(blocks.map((b) => b.id)) : new Set<string>();
  const stale = blocks.filter((b) => b.stale);
  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader
        crumbs={[{ label: "Database" }, { label: "Neon" }]}
        title="Neon"
        sub="Compute state, CU-hours, storage and transfer from the Neon API. Reading them doesn't wake the compute, and the console never connects to the database."
        actions={member.role === "owner" ? <Link href="/connections" className={buttonClass()}>Manage accounts</Link> : undefined}
      />
      {/* Stage 6 create requests: new branches waiting for the owner's approval. */}
      <PendingCreates member={member} types={["neon_branch"]} focus={create ?? null} />
      {stale.length > 0 && (
        <Banner tone="info" title="Neon API isn't responding">
          Showing the last data we got{stale[0].collectedAt ? `, from ${rel(stale[0].collectedAt, now)}` : ""}. The collector retries every 5 minutes.
        </Banner>
      )}
      {blocks.length === 0 && (
        <Card><EmptyState icon={IconDatabase} title="No Neon projects watched yet"
          action={member.role === "owner" ? <Link href="/connections" className={buttonClass({ size: "sm" })}>Open connections</Link> : undefined}>
          {member.role === "owner" ? "Connect a Neon account, then press Sync and tick the projects to watch." : "An owner picks the projects to watch in Connections."}
        </EmptyState></Card>
      )}
      {blocks.map((b) => (
        <section key={b.id} className={cn("flex flex-col gap-4", b.stale && "opacity-60")}>
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="flex items-center gap-2 text-base"><Resource kind="db" name={b.name} dbId={b.id} /></h2>
            <AccountChip name={b.account} />
            <span className="text-[12.5px] text-ink-soft">
              {[b.region, b.pg ? `Postgres ${b.pg}` : null].filter(Boolean).join(" · ")}
              {b.usedBy.length > 0 && <> · used by {b.usedBy.map((u, i) => <span key={u.id}>{i > 0 && ", "}<Resource kind="app" name={u.name} href={`/apps/${u.id}`} /></span>)}</>}
            </span>
            <span className="ml-auto flex items-center gap-2.5">
              {/* Stage 9 slice 2: the owner's read-only connection for the SQL console. */}
              {owner && <SqlAccessButtons id={b.id} alias={b.alias} provider="neon" connected={sqlIds.has(b.id)} />}
              {owner && <CreateButton type="neon_branch" target={b.id} targetName={b.name} label="New branch" />}
              <Status state={b.status.state}>{b.status.label}</Status>
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4 min-[721px]:grid-cols-2 min-[1281px]:grid-cols-4">
            <Card title="Compute this month" meta={<Src kind="api" />}>
              <span className={metric}>{b.cu ? b.cu.value : "—"}<small className={small}>of {NEON_FREE.cuHours} CU-h</small></span>
              <Progress pct={b.cu?.pct ?? 0} tone={(b.cu?.pct ?? 0) >= 80 ? "warn" : undefined} />
              {b.resets && <p className="mt-1.5 text-[12.5px] text-ink-soft">Resets {b.resets}</p>}
              {b.activeHours != null && <p className="text-[12.5px] text-ink-soft">Active {b.activeHours} h this month</p>}
              {b.collectedAt && <p className="text-[12px] text-ink-faint">as of {rel(b.collectedAt, now)}</p>}
            </Card>
            <Card title="Storage" meta={<Src kind="api" />}>
              <span className={metric}>{b.storage.text}<small className={small}>of 1 GB</small></span>
              <Progress pct={b.storage.pct} tone={b.storage.pct >= 80 ? "warn" : undefined} />
            </Card>
            <Card title="Data transfer" meta={<Src kind="api" />}>
              <span className={metric}>{b.transfer?.text ?? "—"}<small className={small}>of 5 GB</small></span>
              <Progress pct={b.transfer?.pct ?? 0} tone={(b.transfer?.pct ?? 0) >= 80 ? "warn" : undefined} />
            </Card>
            <Card title="Scale to zero">
              <span className={metric}>{NEON_FREE.scaleToZeroMin}<small className={small}>min</small></span>
              <p className="mt-1.5 text-[12.5px] text-ink-soft">Fixed on the free plan.</p>
            </Card>
          </div>
          <Card title="Branches and computes" meta={`${b.branches.length} of ${NEON_FREE.branches} branches`} flush>
            <PlainTable
              head={["Branch", "Compute", <span key="s">State<Src kind="api" /></span>, "Autoscaling", <span key="z">Size<Src kind="api" /></span>, <span key="l">Last active<Src kind="api" /></span>, ""]}
              rows={b.branches.map((x) => ({
                key: x.id, state: x.status.state, text: x.name,
                row: (
                  <tr className={rowClass}>
                    <td className={td}><Resource kind="br" name={x.name} />{x.isDefault && <> <Tag>Default</Tag></>}</td>
                    <td className={cn(td, "font-mono text-[12.5px] text-ink-soft")}>{x.endpoint ?? "—"}</td>
                    <td className={td}><Status state={x.status.state}>{x.status.label}</Status></td>
                    <td className={cn(td, "font-mono")}>{x.autoscaling}</td>
                    <td className={cn(td, "font-mono")}>{x.size}</td>
                    <td className={cn(td, "text-ink-soft")}>{x.lastActive}</td>
                    <td className={td}>
                      {act && x.endpoint && x.status.state === "idle" && (
                        <WakeButton endpoint={x.endpoint} used={b.cu ? `${b.cu.value} of ${NEON_FREE.cuHours}` : null} run={wakeAction.bind(null, b.id, x.endpoint)} />
                      )}
                      {x.endpoint && (x.status.state === "ok" || x.status.state === "build") && <span className="text-ink-faint">Running</span>}
                    </td>
                  </tr>
                ),
              }))}
            />
          </Card>
        </section>
      ))}
    </>
  );
}
