import { IconDatabase } from "@tabler/icons-react";
import Link from "next/link";
import { buttonClass, Card, EmptyState, PageHeader } from "@/components/kit";
import { NoAccess } from "@/components/no-access";
import { Status } from "@/components/status";
import { rowClass, td, tableClass, TableHead } from "@/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { pageGate } from "@/lib/auth";
import { aliasBook, listDatabases } from "@/lib/data/cached";
import { sqlTargets } from "@/lib/data/sql-db";
import { cn } from "@/lib/utils";
import { firebaseRows } from "@/lib/view/databases";
import { rel } from "@/lib/view/format";
import { FirestoreConsole, type FirestoreTarget } from "./firestore-console";
import { SqlAccessButtons } from "./sql-access-dialog";
import { type ConsoleTarget, SqlConsole } from "./sql-console";

// Stage 9 slice 2: Databases → SQL console (owner only). Postgres (Supabase, Neon) through the owner's read-only role,
// and a Firestore query builder through the Firebase account's viewer service account. The page receives aliases and
// states only: no connection string, credential or real database name.

// A run is one connection: connect (5 s) + statement (5 s) + slack. The automatic Supabase setup (slice 2b: two API
// calls, then up to three save-time checks a few seconds apart) needs longer.
export const maxDuration = 60;

const wakeLabel = { idle: "Compute idle", active: "Compute active", unknown: "Compute state unknown" } as const;

export default async function SqlPage() {
  const gate = await pageGate("owner");
  if (!gate.ok) return <NoAccess role={gate.member.role} />;
  const now = new Date();
  const [targets, fsRows, book] = await Promise.all([sqlTargets(), listDatabases("firestore"), aliasBook()]);
  const connected: ConsoleTarget[] = targets.filter((t) => t.connected && !t.paused).map((t) => ({ id: t.id, alias: t.alias, provider: t.provider, wake: t.wake }));
  const fs: FirestoreTarget[] = firebaseRows(fsRows, book).map((v) => ({ id: v.id, alias: v.alias, readsToday: "note" in v.ops ? null : v.ops.reads?.n ?? null }));
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Databases" }, { label: "SQL console" }]}
        title="SQL console"
        sub="Read-only queries against your app databases, run with a role you create for the console. Every run is checked on the server, rolled back, capped and audited (database alias and a fingerprint, never the query text)."
      />
      <Tabs defaultValue="postgres" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="postgres">Postgres</TabsTrigger>
          <TabsTrigger value="firestore">Firestore</TabsTrigger>
          <TabsTrigger value="access">SQL access</TabsTrigger>
        </TabsList>
        <TabsContent value="postgres" className="flex flex-col gap-4">
          <Card>
            {connected.length ? <SqlConsole targets={connected} /> : (
              <EmptyState icon={IconDatabase} title="No database has SQL access yet">
                Add a read-only connection string under SQL access, or on a Supabase or Neon row.
              </EmptyState>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="firestore" className="flex flex-col gap-4">
          <Card>
            {fs.length ? <FirestoreConsole targets={fs} /> : (
              <EmptyState icon={IconDatabase} title="No Firebase projects watched"
                action={<Link href="/connections" className={buttonClass({ size: "sm" })}>Open connections</Link>}>
                The query builder uses the Firebase account&apos;s service account (it needs datastore.viewer on the project).
              </EmptyState>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="access" className="flex flex-col gap-4">
          <Card flush title="Read-only connections" meta="Owner only · stored encrypted, never shown again">
            {targets.length === 0 ? (
              <EmptyState icon={IconDatabase} title="No Supabase or Neon databases watched">Pick databases to watch in Connections first.</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className={tableClass}>
                  <TableHead head={["Database", "Provider", "SQL access", "Last run", ""]} />
                  <tbody>
                    {targets.map((t) => (
                      <tr key={t.id} className={rowClass}>
                        <td className={cn(td, "font-mono")}>{t.alias}</td>
                        <td className={td}>
                          {t.provider === "supabase" ? "Supabase" : "Neon"}
                          {t.wake && <div className="text-[12px] text-ink-faint">{wakeLabel[t.wake]}</div>}
                          {t.paused && <div className="text-[12px] text-ink-faint">Paused</div>}
                        </td>
                        <td className={td}>
                          {t.connected
                            ? <><Status state="ok">Role <span className="font-mono">{t.role}</span></Status>{t.verifiedAt && <div className="text-[12px] text-ink-faint">checked {rel(t.verifiedAt, now)}</div>}</>
                            : <span className="text-ink-faint">Not added</span>}
                        </td>
                        <td className={cn(td, "text-ink-soft")}>{t.lastRunAt ? rel(t.lastRunAt, now) : "—"}</td>
                        <td className={td}><SqlAccessButtons id={t.id} alias={t.alias} provider={t.provider} connected={t.connected} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
