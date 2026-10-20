import { IconCloud } from "@tabler/icons-react";
import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { Banner, buttonClass, Card, EmptyState, PageHeader } from "@/components/kit";
import { ExtraDbTable } from "@/components/extra-db-table";
import { AutoRefresh } from "@/components/live";
import { AccountChip } from "@/components/resource";
import { td } from "@/components/table";
import { db } from "@/db/client";
import { accounts, settings } from "@/db/schema";
import { requirePageMember } from "@/lib/auth";
import { aliasBook, listDatabases } from "@/lib/data/cached";
import { D1_FREE } from "@/lib/databases/extra";
import { cn } from "@/lib/utils";
import { D1_ACCESS_KEY, d1AccessNote, d1Views, parseD1Access } from "@/lib/view/extra-dbs";

// Stage 8: Cloudflare D1 databases under the Cloudflare accounts on Connections (the same token: "D1 Read" lists them,
// "Account Analytics Read" adds rows read and written). New databases are watched automatically and read hourly.
export default async function D1Page() {
  const member = await requirePageMember();
  const now = new Date();
  const [rows, book, cfAccounts, accessRow] = await Promise.all([
    listDatabases("d1_database"), aliasBook(),
    // Labels only: no credential column is selected.
    db().select({ id: accounts.id, label: accounts.label }).from(accounts).where(eq(accounts.provider, "cloudflare")).orderBy(asc(accounts.createdAt)).limit(20),
    db().select({ value: settings.value }).from(settings).where(eq(settings.key, D1_ACCESS_KEY)).limit(1),
  ]);
  const access = parseD1Access(accessRow[0]?.value);
  const views = d1Views(rows, now, book);
  const notes = cfAccounts.flatMap((a) => {
    const note = d1AccessNote(access[a.id]);
    return note ? [{ ...a, note }] : [];
  });
  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader
        crumbs={[{ label: "Databases" }, { label: "Cloudflare D1" }]}
        title="Cloudflare D1"
        sub="Size from the D1 API and rows read and written today (UTC) from Cloudflare's GraphQL analytics, read hourly with the Cloudflare token on Connections. The console never runs a query on a database."
        actions={member.role === "owner" ? <Link href="/connections" className={buttonClass()}>Manage accounts</Link> : undefined}
      />
      {member.role === "owner" && notes.map((a) => (
        <Banner key={a.id} tone={a.note.tone === "warn" ? "warning" : "info"} title={<span className="inline-flex items-center gap-2">D1 access <AccountChip name={a.label} /></span>}>
          {a.note.text}
        </Banner>
      ))}
      {views.length === 0 ? (
        <Card><EmptyState icon={IconCloud} title={cfAccounts.length ? "No D1 databases found yet" : "No Cloudflare account connected"}
          action={member.role === "owner" ? <Link href="/connections" className={buttonClass({ size: "sm" })}>Open connections</Link> : undefined}>
          {cfAccounts.length
            ? "D1 databases appear here after the hourly read, once the Cloudflare token has Account → D1 → Read."
            : "Connect Cloudflare with a token that includes Account → D1 → Read (and Account → Account Analytics → Read for row counts)."}
        </EmptyState></Card>
      ) : (
        <ExtraDbTable
          title="D1 databases"
          meta={`Free plan: ${D1_FREE.databases} databases, 500 MB each, 5 GB per account, 5M rows read and 100k written a day`}
          rows={views} source="D1 API / GraphQL"
          extraHead={["Size", "Tables"]}
          extraCells={(r) => <><td className={cn(td, "font-mono")}>{r.size}</td><td className={cn(td, "font-mono")} title="Cloudflare marks this count as no longer accurate">{r.tables}</td></>}
        />
      )}
    </>
  );
}
