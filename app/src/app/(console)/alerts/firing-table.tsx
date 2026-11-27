import { HoverLink as Link } from "@/components/hover-link";
import { MaskedText } from "@/components/alias";
import { buttonClass, EmptyState, Tag } from "@/components/kit";
import { ListFilter } from "@/components/list-filter";
import { PlainTable } from "@/components/plain-table";
import { AlertSev } from "@/components/severity";
import { Status } from "@/components/status";
import { type ListRow, rowClass, td, tdWrap } from "@/components/table";
import type { FiringRow } from "@/lib/data/alerts-db";
import { cn } from "@/lib/utils";
import { ruleName } from "@/lib/alerts/catalog";
import { eventTime } from "@/lib/view/format";
import { notifiedText, SEV_OPTIONS, tookText } from "@/lib/view/alerts";
import type { SourceFilter } from "@/lib/view/sources";
import { AlertMenu } from "./alert-menu";

const HEAD = ["Severity", "Alert", "Resource", "Since", "Notified", ""];
const SOURCE_HEAD = ["Severity", "Alert", "Source", "Resource", "Since", "Notified", ""];

const SOURCES: [SourceFilter, string][] = [["all", "All"], ["watchbell", "Watchbell"], ["alertmanager", "Alertmanager"]];

// Links, not client state: the filter survives the page's 60 s refresh and a reload.
export function SourceFilterBar({ active }: { active: SourceFilter }) {
  return (
    <nav aria-label="Source" className="flex w-fit gap-1 rounded-lg bg-sunken p-[3px]">
      {SOURCES.map(([k, label]) => (
        <Link key={k} href={k === "all" ? "/alerts" : `/alerts?source=${k}`} aria-current={active === k ? "page" : undefined}
          className={cn(buttonClass({ size: "sm", variant: active === k ? "primary" : "ghost" }))}>{label}</Link>
      ))}
    </nav>
  );
}

// The labels Alertmanager sent, folded away under the message (no client code: a native disclosure).
function ExternalLabels({ labels, subject }: { labels: Record<string, string> | null; subject: string }) {
  const entries = Object.entries(labels ?? {});
  return (
    <details className="mt-1 text-[12.5px]">
      <summary className="cursor-pointer text-ink-soft">Labels ({entries.length}) · fingerprint <span className="font-mono">{subject.replace(/^am:/, "")}</span></summary>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {entries.map(([k, v]) => <div key={k} className="contents"><dt className="font-mono text-ink-faint">{k}</dt><dd className="break-all"><MaskedText text={v} /></dd></div>)}
      </dl>
    </details>
  );
}
const RESOLVED_HEAD = ["Severity", "Alert", "Resource", "Started", "Outcome"];

// Only apps have a page to link to until stages 3 and 4 add theirs.
const resourceHref = (a: { resourceId: string | null; resourceKind: string | null }) => (a.resourceId && a.resourceKind === "app" ? `/apps/${a.resourceId}` : null);
// The title names what the rule watched: "web /" for a monitor, the app or database name, "vercel · acme" for an account.
const resourceText = (a: { title: string }) => a.title;

// `search`: the stored (real) text, so the filter also finds an alert by a database's real name (privacy); the rows
// themselves come already cleaned (hideAlert).
// `sources`: a source (Alertmanager) is set up, so each row says where it came from (1.8.6).
export function FiringTable({ rows, now, act, sources = false }: { rows: (FiringRow & { search?: string })[]; now: Date; act: boolean; sources?: boolean }) {
  if (rows.length === 0) {
    return <EmptyState title="No alerts firing">Everything the rules watch looks fine.</EmptyState>;
  }
  const list: ListRow[] = rows.map((a) => {
    const n = notifiedText(a, now);
    const href = resourceHref(a);
    const silenced = a.silencedUntilResolved || (a.silencedUntil !== null && a.silencedUntil.getTime() > now.getTime());
    const external = a.ruleKey === "ExternalAlert";
    return {
      key: a.id,
      state: a.severity,
      text: [a.severity, ruleName(a.ruleKey), a.ruleKey, a.title, a.message, resourceText(a), a.providerIncident ?? "", a.search ?? "", external ? "Alertmanager" : "", ...Object.entries(a.labels ?? {}).flat()].join(" "),
      row: (
        <tr className={rowClass}>
          <td className={td}><AlertSev severity={a.severity} /></td>
          <td className={cn(td, tdWrap)}>
            <b className="font-medium">{ruleName(a.ruleKey)}</b> <span className="font-mono text-[11px] text-ink-faint">{a.ruleKey}</span>
            {a.providerIncident && <span className="ml-1.5"><Tag>Provider incident · {a.providerIncident}</Tag></span>}
            <div className="text-ink-soft"><MaskedText text={a.message} /></div>
            {a.causedBy && <div className="text-[12.5px] text-ink-faint">Caused by <MaskedText text={a.causedBy} /> · notifications muted</div>}
            {external && <ExternalLabels labels={a.labels} subject={a.subject} />}
          </td>
          {sources && <td className={td}><Tag>{external ? "Alertmanager" : "Watchbell"}</Tag></td>}
          <td className={td}>{href ? <Link href={href}><MaskedText text={resourceText(a)} inLink /></Link> : <MaskedText text={resourceText(a)} />}</td>
          <td className={cn(td, "text-ink-soft")}>{eventTime(a.startedAt, now)}</td>
          <td className={cn(td, "text-ink-soft")}>{n.state === "ok" ? n.text : <Status state={n.state}>{n.text}</Status>}</td>
          <td className={td}>{act && <AlertMenu id={a.id} label={`${a.ruleKey} ${a.title}`} silenced={silenced} resourceHref={href} />}</td>
        </tr>
      ),
    };
  });
  return <ListFilter placeholder="Filter alerts" states={SEV_OPTIONS} head={sources ? SOURCE_HEAD : HEAD} rows={list} />;
}

export type ResolvedRow = { id: string; ruleKey: string; severity: "critical" | "warning" | "info"; title: string; resourceId?: string | null; startedAt: Date; resolvedAt: Date };

export function ResolvedTable({ rows, now }: { rows: ResolvedRow[]; now: Date }) {
  const list: ListRow[] = rows.map((a) => ({
    key: a.id,
    state: "ok",
    text: "",
    row: (
      <tr className={rowClass}>
        <td className={td}><AlertSev severity={a.severity} /></td>
        <td className={td}><b className="font-medium">{ruleName(a.ruleKey)}</b> <span className="font-mono text-[11px] text-ink-faint">{a.ruleKey}</span></td>
        <td className={td}><MaskedText text={resourceText(a)} /></td>
        <td className={cn(td, "text-ink-soft")}>{eventTime(a.startedAt, now)}</td>
        <td className={td}><Status state="ok">Resolved after {tookText(a.startedAt, a.resolvedAt)}</Status></td>
      </tr>
    ),
  }));
  return <PlainTable head={RESOLVED_HEAD} rows={list} />;
}
