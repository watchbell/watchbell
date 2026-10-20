import Link from "next/link";
import type { ReactNode } from "react";
import { MaskedText } from "@/components/alias";
import { Sparkline } from "@/components/charts";
import { Resource } from "@/components/resource";
import { CveTag } from "@/components/severity";
import { Src } from "@/components/sources";
import { Status } from "@/components/status";
import { type ListRow, rowClass, td } from "@/components/table";
import type { AppSummary } from "@/lib/data/apps-db";
import type { LinkedDb } from "@/lib/data/databases-db";
import { outboundLinks } from "@/lib/demo/links";
import { DB_PROVIDER_NAME, dbHref, dbProvider } from "@/lib/links";
import { cn } from "@/lib/utils";
import { type AliasBook, dbAlias, searchText } from "@/lib/view/display-name";
import { lastDeployText, msText, pct } from "@/lib/view/format";
import { appStatus } from "@/lib/view/labels";
import { cveTag } from "@/lib/view/security";
import { AppMenu } from "./app-menu";

const mono = "font-mono text-[12.5px]";

// Columns as in the mockup; Overview's compact table drops Domain.
export function appHead(compact: boolean): ReactNode[] {
  return [
    "Name", "Status", "Database", ...(compact ? [] : ["Domain"]),
    <span key="up">Uptime 30d<Src kind="own" /></span>,
    <span key="resp">Response 24h<Src kind="own" /></span>,
    <span key="dep">Last deploy<Src kind="api" /></span>,
    "",
  ];
}

// The Database cell shows the alias with click to reveal (privacy); the provider name links to its page, since the
// reveal can't sit inside a link. Shared with the app page.
export function DbCell({ db }: { db: Pick<LinkedDb, "id" | "name" | "kind"> }) {
  return <><Resource kind={db.kind === "firestore" ? "fs" : "db"} name={db.name} dbId={db.id} /> <Link href={dbHref(db.kind)} className="text-ink-faint hover:text-brand">{DB_PROVIDER_NAME[dbProvider(db.kind)]}</Link></>;
}

export function appListRows(apps: AppSummary[], o: { compact: boolean; canAct: boolean; now: Date; book: AliasBook }): ListRow[] {
  return apps.map((a) => {
    const s = appStatus(a);
    const last = lastDeployText(a.lastDeploy, o.now);
    const paused = a.monitors.length > 0 && a.monitors.every((m) => m.ownerPaused);
    const cve = cveTag(a.security);
    return {
      key: a.id,
      state: s.state,
      // The filter finds an app by its database's alias or real name.
      text: searchText([a.name, cve?.label ?? "", s.label, a.database ? dbAlias(o.book, a.database.id) : "None", a.domain, pct(a.uptime30), last], [a.database?.name]),
      row: (
        <tr className={rowClass}>
          <td className={td}><Resource kind="app" name={a.name} href={`/apps/${a.id}`} />{cve && <CveTag tag={cve} />}</td>
          <td className={td}><Status state={s.state}>{s.label}</Status></td>
          <td className={td}>
            {a.database ? <DbCell db={a.database} /> : <span className="text-ink-faint">None</span>}
          </td>
          {!o.compact && <td className={cn(td, mono)}><MaskedText text={a.domain} /></td>}
          <td className={cn(td, mono)}>{pct(a.uptime30)}</td>
          <td className={td}>
            <span className="inline-flex items-center gap-2">
              <Sparkline values={a.response.hourly} width={80} height={24} tone={s.state === "err" ? "err" : "accent"} label={`${a.name}: hourly p95 response time, last 24 hours`} />
              <span className={cn(mono, "text-ink-soft")}>{msText(a.response.p95)}</span>
            </span>
          </td>
          <td className={cn(td, "text-ink-soft")}>{last}</td>
          <td className={td}>{o.canAct && <AppMenu app={{ id: a.id, name: a.name, siteUrl: outboundLinks() ? `https://${a.domain}` : null, paused, monitorCount: a.monitors.length }} />}</td>
        </tr>
      ),
    };
  });
}
