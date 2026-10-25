import { IconFlame } from "@tabler/icons-react";
import Link from "next/link";
import { Banner, buttonClass, Card, EmptyState, PageHeader, Progress } from "@/components/kit";
import { ListFilter } from "@/components/list-filter";
import { AutoRefresh } from "@/components/live";
import { AccountChip, Resource } from "@/components/resource";
import { Src } from "@/components/sources";
import { Status } from "@/components/status";
import { rowClass, td, tdWrap } from "@/components/table";
import { requirePageMember } from "@/lib/auth";
import { aliasBook, listDatabases } from "@/lib/data/cached";
import { cn } from "@/lib/utils";
import { firebaseRows } from "@/lib/view/databases";
import { hideEmails, searchText } from "@/lib/view/display-name";
import { actionsLabel, canAct } from "@/lib/view/labels";
import { CreateButton, DisconnectGoogleCreateButton } from "@/components/create/create-dialog";
import { PendingCreates } from "@/components/create/pending-creates";
import { CREATE_CALLBACK_TEXT } from "@/lib/create/connect-text";
import { createGrantConnected } from "@/lib/data/create-db";
import { FIRESTORE_SIZE_NOTE } from "@/lib/databases/firebase";
import { outboundLinks } from "@/lib/demo/links";
import { FirestoreRowMenu } from "./row-menu";

// Stage 6 create requests: Firebase's create runs a few long-running Google operations (polled) after approval.
export const maxDuration = 60;

const faint = "text-[12px] text-ink-faint";

// One of the three op counters: "2,100 / 50k" with a bar, or a dash when Cloud Monitoring gave nothing for it.
function Count({ c, of }: { c: { n: number; pct: number } | null; of: string }) {
  if (!c) return <span className="text-ink-faint">—</span>;
  return <><span className="font-mono">{c.n.toLocaleString("en")}</span> <span className="text-ink-faint">/ {of}</span><Progress pct={c.pct} tone={c.pct >= 80 ? "warn" : undefined} /></>;
}

export default async function FirebasePage({ searchParams }: { searchParams: Promise<{ create?: string; google?: string }> }) {
  const member = await requirePageMember();
  const { create, google } = await searchParams;
  const googleNote = google ? CREATE_CALLBACK_TEXT[google] : undefined;
  const createGrant = member.role === "owner" ? await createGrantConnected().catch(() => null) : null;
  const now = new Date();
  const act = canAct(member.role);
  const links = outboundLinks();
  const [rows, book] = await Promise.all([listDatabases("firestore"), aliasBook()]);
  const view = firebaseRows(rows, book);
  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader
        crumbs={[{ label: "Database" }, { label: "Firebase" }]}
        title="Firebase"
        sub="Firestore has no running or stopped state. Every 5 minutes the collector reads one health document (288 of your 50k daily reads)."
        actions={member.role === "owner" ? <><Link href="/connections" className={buttonClass()}>Manage accounts</Link>{createGrant !== null && <DisconnectGoogleCreateButton />}<CreateButton type="firebase_project" target="" targetName="Firebase" label="New project" /></> : undefined}
      />
      {googleNote && <Banner tone={googleNote.tone === "ok" ? "info" : "danger"} title={googleNote.tone === "ok" ? "Google connected" : "Google wasn't connected"}>{googleNote.text}</Banner>}
      {/* Stage 6 create requests: new Firebase projects waiting for the owner's approval. */}
      <PendingCreates member={member} types={["firebase_project"]} focus={create ?? null} />
      <Banner tone="info" title="Firestore usage isn't readable on the Spark plan">
        Reads, writes, and deletes today come from Cloud Monitoring, which answers that billing (Blaze) is required on Spark, so on Spark those columns say so. On Blaze they are read every hour (since midnight Pacific time, when the free quota resets). {FIRESTORE_SIZE_NOTE}
      </Banner>
      <Card flush>
        {view.length === 0 ? (
          <EmptyState icon={IconFlame} title="No Firebase projects watched yet"
            action={member.role === "owner" ? <Link href="/connections" className={buttonClass({ size: "sm" })}>Open connections</Link> : undefined}>
            {member.role === "owner" ? "Connect a Google service account, then press Sync and tick the projects to watch." : "An owner picks the projects to watch in Connections."}
          </EmptyState>
        ) : (
          <ListFilter
            placeholder="Filter by name"
            groups={[...new Set(view.map((v) => v.account))].sort()}
            head={["Project", "Account", <span key="h">Health<Src kind="own" /></span>, <span key="r">Reads today<Src kind="api">API · hourly</Src></span>,
              <span key="w">Writes today<Src kind="api">API · hourly</Src></span>, <span key="d">Deletes today<Src kind="api">API · hourly</Src></span>,
              <span key="u">Auth users<Src kind="api">API · daily</Src></span>, "Used by", ""]}
            rows={view.map((v) => ({
              key: v.id, state: v.health.state, group: v.account,
              text: searchText([v.alias, hideEmails(v.account), v.health.label, ...v.usedBy.map((u) => u.name)], [v.name, v.account]),
              row: (
                <tr className={cn(rowClass, v.stale && "opacity-60")}>
                  <td className={td}><Resource kind="fs" name={v.name} dbId={v.id} /></td>
                  <td className={td}><AccountChip name={v.account} /></td>
                  <td className={td}><Status state={v.health.state}>{v.health.label}</Status></td>
                  {"note" in v.ops ? (
                    <td colSpan={3} className={cn(td, tdWrap, "text-ink-faint")}>{v.ops.note}</td>
                  ) : (
                    <>
                      <td className={td}><Count c={v.ops.reads} of="50k" /></td>
                      <td className={td}><Count c={v.ops.writes} of="20k" /></td>
                      <td className={td}><Count c={v.ops.deletes} of="20k" /></td>
                    </>
                  )}
                  <td className={cn(td, "font-mono")} title={v.usersNote ?? undefined}>{v.users ?? "—"}</td>
                  <td className={td}>{v.usedBy.length ? v.usedBy.map((u) => <div key={u.id}><Resource kind="app" name={u.name} href={`/apps/${u.id}`} /></div>) : <span className={faint}>Not linked</span>}</td>
                  <td className={td}>
                    {act && (
                      <FirestoreRowMenu id={v.id} alias={v.alias} label={actionsLabel(v.alias)} links={[
                        // Demo: the project is made up, so there is no Firebase console to open (lib/demo/links.ts).
                        ...(links ? [
                          { label: "Open Firebase console", href: `https://console.firebase.google.com/project/${encodeURIComponent(v.projectId)}/overview` },
                          { label: "Open usage page", href: `https://console.firebase.google.com/project/${encodeURIComponent(v.projectId)}/firestore/databases/-default-/usage` },
                        ] : []),
                      ]} />
                    )}
                  </td>
                </tr>
              ),
            }))}
          />
        )}
      </Card>
    </>
  );
}
