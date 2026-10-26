import { IconSitemap } from "@tabler/icons-react";
import Link from "next/link";
import { buttonClass, Card, EmptyState, PageHeader, Tag } from "@/components/kit";
import { ListFilter } from "@/components/list-filter";
import { AutoRefresh } from "@/components/live";
import { AccountChip, ResourceBadge } from "@/components/resource";
import { Src } from "@/components/sources";
import { Status } from "@/components/status";
import { rowClass, td } from "@/components/table";
import { requirePageMember } from "@/lib/auth";
import { getZoneView, listZoneOptions } from "@/lib/data/cached";
import { writeAccess } from "@/lib/data/provider-action-db";
import { daysLeft, edgeCertSummary, isoDate, pointsToVercel, sslModeLabel } from "@/lib/network/rules";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import { longDate } from "@/lib/view/format";
import { accessHint } from "@/lib/view/access";
import { canAct } from "@/lib/view/labels";
import { ttlText, zoneStatusLabel } from "@/lib/view/network";
import { DnsRecordActions } from "./record-actions";
import { RecordContent } from "./record-content";
import { ZonePicker } from "./zone-picker";
import { zoneParam } from "./zone-param";
import { CreateButton } from "@/components/create/create-dialog";
import { PendingCreates } from "@/components/create/pending-creates";

const KV = "grid grid-cols-[170px_minmax(0,1fr)] gap-x-4 gap-y-2.5 max-[720px]:grid-cols-1 max-[720px]:gap-y-1 [&_dd]:min-w-0 [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-ink-soft";
const faint = "text-ink-faint";

export default async function DnsPage({ searchParams }: { searchParams: Promise<{ zone?: string; create?: string }> }) {
  const member = await requirePageMember();
  const { zone, create } = await searchParams;
  const now = new Date();
  const options = await listZoneOptions();
  // Only a watched zone's id reaches the cached read (review m3): any other ?zone= value reads the first zone under the
  // one shared "null" key, so a made-up id can't add cache entries.
  const z = await getZoneView(zoneParam(zone, options));
  const act = canAct(member.role);
  if (!z) {
    return (
      <>
        <PageHeader crumbs={[{ label: "Hosting" }, { label: "DNS records" }]} title="DNS records" />
        <Card>
          <EmptyState icon={IconSitemap} title="No Cloudflare zone watched yet"
            action={member.role === "owner" ? <Link className={buttonClass({ size: "sm" })} href="/connections">Open connections</Link> : undefined}>
            Connect Cloudflare and tick its zones in Sync. Zones are read every hour.
          </EmptyState>
        </Card>
      </>
    );
  }
  const f = z.facts;
  const status = zoneStatusLabel(f.zone?.status ?? null, f.zone?.paused ?? false);
  const edge = edgeCertSummary(f.certs);
  const edgeAt = isoDate(edge.expiresOn);
  const exp = isoDate(f.rdap?.expiresAt);
  const expDays = daysLeft(exp, now);
  const checked = isoDate(f.rdap?.checkedAt);
  const ssl = sslModeLabel(f.ssl?.mode ?? null);
  // Slice 2 (B7): when this token's last DNS edit was refused, say so here too. The buttons stay: the owner may have
  // replaced the token since (the hint turns on again with the next edit that works).
  const owner = member.role === "owner";
  const hint = owner && z.accountId ? accessHint("cloudflare", (await writeAccess([z.accountId])).get(z.accountId), null) : null;
  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader
        crumbs={[{ label: "Hosting" }, { label: "DNS records" }]}
        badge={<ResourceBadge kind="dns" />}
        title={z.name}
        sub="Your Cloudflare zones, read every hour. Watchbell never deletes a record."
        more="Owners can switch a record between proxied and DNS only, or edit an A, AAAA, CNAME or TXT record, after a review that shows the old and new value. New records are added only through a request an owner approves (Add record)."
        actions={<>{options.length > 1 && <ZonePicker zones={options} current={z.id} />}<AccountChip name={z.accountLabel} />{owner && <CreateButton type="dns_record" target={z.id} targetName={z.name} label="Add record" />}</>}
      />
      {/* Stage 6 create requests: the DNS records waiting for the owner's approval. */}
      <PendingCreates member={member} types={["dns_record"]} focus={create ?? null} />
      <Card title="Zone" meta={<><Src kind="api" /><Src kind="api">RDAP</Src></>}>
        <dl className={KV}>
          <dt>Status</dt><dd><Status state={status.state}>{status.label}</Status></dd>
          <dt>Nameservers</dt><dd className="font-mono text-[12.5px]">{f.zone?.nameServers.join(", ") || "—"}</dd>
          <dt>SSL/TLS mode</dt>
          <dd>{ssl ?? <span className={faint}>Unknown{f.ssl?.error?.includes("Zone Settings Read") ? " · the token needs Zone Settings read" : ""}</span>}</dd>
          <dt>Edge certificate</dt>
          <dd>{edge.state === "unknown" ? <span className={faint}>{edge.label}</span> : <><Status state={edge.state}>{edge.label}</Status>{edgeAt && <span className={faint}> · expires {longDate(edgeAt)}, Cloudflare renews it</span>}</>}</dd>
          <dt>Domain expiry</dt>
          <dd>{exp
            ? <>{longDate(exp)} <span className={faint}>· {expDays !== null && expDays < 0 ? `expired ${-expDays} day${expDays === -1 ? "" : "s"} ago` : `in ${expDays} day${expDays === 1 ? "" : "s"}`}{f.rdap?.registrar ? ` · ${f.rdap.registrar}` : ""}{checked ? ` · checked ${ago(checked, now)}` : ""}</span></>
            : <span className={faint}>Unknown{f.rdap?.error ? ` · ${f.rdap.error}` : " · not read yet"}</span>}</dd>
        </dl>
        {f.cfErrors.filter((e) => e !== f.ssl?.error).map((e) => <p key={e} className="mt-3 text-[12.5px] text-ink-soft">{e}</p>)}
        {f.recordsTruncated && <p className="mt-3 text-[12.5px] text-ink-soft">This zone has more than 2,000 records. Only the first 2,000 are shown.</p>}
        {hint?.tone === "off" && <p className="mt-3 text-[12.5px] text-warn">Editing is off: the last edit was refused. Add &quot;Zone → DNS → Edit&quot; to this Cloudflare token on <Link href="/connections?provider=cloudflare" className="underline">Connections</Link>, then try again.</p>}
      </Card>
      <Card flush>
        <ListFilter
          placeholder="Filter records"
          states={[["ok", "Fine"], ["warn", "Proxied in front of Vercel"]]}
          head={["Type", "Name", "Content", "Proxy", "TTL", ""]}
          rows={f.records.map((r) => {
            const vercel = pointsToVercel(r);
            const bad = r.proxied && vercel;
            return {
              key: r.id, state: bad ? "warn" : "ok", text: `${r.type} ${r.name} ${r.content}`,
              row: (
                <tr className={rowClass}>
                  <td className={td}><Tag>{r.type}</Tag></td>
                  <td className={cn(td, "font-mono text-[12.5px]")}>{r.name === z.name ? "@" : r.name.replace(`.${z.name}`, "")}</td>
                  <td className={cn(td, "font-mono text-[12.5px]")}><div className="flex min-w-0 items-center gap-1.5"><RecordContent value={r.content} />{vercel && <Tag>Vercel</Tag>}</div></td>
                  <td className={td}>{r.proxied ? <Status state={bad ? "warn" : "info"}>Proxied</Status> : <Status state="off">DNS only</Status>}</td>
                  <td className={cn(td, "text-ink-soft")}>{ttlText(r.ttl)}</td>
                  <td className={td}>{act && <DnsRecordActions zoneId={z.id} r={r} owner={owner} vercel={vercel} />}</td>
                </tr>
              ),
            };
          })}
        />
      </Card>
    </>
  );
}
