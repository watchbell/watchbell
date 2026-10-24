import { IconWorld } from "@tabler/icons-react";
import Link from "next/link";
import { Banner, Button, buttonClass, Card, EmptyState, PageHeader } from "@/components/kit";
import { ListFilter } from "@/components/list-filter";
import { AutoRefresh } from "@/components/live";
import { Resource } from "@/components/resource";
import { Src } from "@/components/sources";
import { Status } from "@/components/status";
import { rowClass, td, tdWrap } from "@/components/table";
import { requirePageMember } from "@/lib/auth";
import { listDomains } from "@/lib/data/cached";
import { daysLeft, isoDate, pointsToVercel } from "@/lib/network/rules";
import { cn } from "@/lib/utils";
import { canAct } from "@/lib/view/labels";
import { certCell, dnsCell, expiryCell, proxiedBannerText, vercelCell } from "@/lib/view/network";
import { SetDnsOnlyButton } from "../dns/record-actions";
import { RecheckButton } from "./recheck-button";
import { MaskedText } from "@/components/alias";
import { outboundLinks } from "@/lib/demo/links";

// Re-check runs a TLS handshake and an RDAP read (up to ~20 s).
export const maxDuration = 30;

const sub = "text-xs text-ink-faint";

// Slice 2: the banner's Set DNS only acts on this domain's first proxied record that points to Vercel (Owner only, like
// every DNS edit; an Operator sees it disabled).
function dnsOnlyAction(d: { zoneId: string | null; records: { id: string; type: string; name: string; content: string; ttl: number; proxied: boolean; comment: string | null }[]; vercel: { recommendedIps: string[] } | null }, owner: boolean) {
  const r = d.records.find((x) => x.proxied && pointsToVercel(x, d.vercel?.recommendedIps ?? []));
  if (!r || !d.zoneId) return undefined;
  if (!owner) return <span title="Owner only" className="inline-flex"><Button size="sm" disabled aria-label="Set DNS only: Owner only">Set DNS only</Button></span>;
  return <SetDnsOnlyButton zoneId={d.zoneId} r={r} />;
}

export default async function DomainsPage() {
  const member = await requirePageMember();
  const now = new Date();
  const list = await listDomains();
  const act = canAct(member.role);
  const links = outboundLinks(); // demo: the domains are made up, so no Visit
  const proxied = list.filter((d) => dnsCell(d.records, d.isVercel, d.zoneName, d.vercel?.recommendedIps ?? []).proxiedToVercel);
  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader
        crumbs={[{ label: "Hosting" }, { label: "Domains" }]}
        title="Domains"
        sub="Every domain of a watched app. DNS from Cloudflare, configuration from Vercel, domain expiry from RDAP, certificate expiry from our own TLS check."
      />
      {proxied.map((d) => (
        <Banner key={d.id} tone="warning" title={`${d.name} is proxied by Cloudflare`} action={act ? dnsOnlyAction(d, member.role === "owner") : undefined}>
          {proxiedBannerText(daysLeft(isoDate(d.tls?.notAfter), now))}
        </Banner>
      ))}
      <Card flush>
        {list.length === 0 ? (
          <EmptyState icon={IconWorld} title="No domains yet">
            Domains appear once an app is watched. They are read from Vercel every 6 hours.
          </EmptyState>
        ) : (
          <ListFilter
            placeholder="Filter by domain"
            states={[["ok", "Healthy"], ["warn", "Needs attention"]]}
            head={["Domain", "Project", <>Domain expiry<Src kind="api">RDAP</Src></>, <>DNS<Src kind="api" /></>, <>Vercel config<Src kind="api" /></>, <>Certificate<Src kind="own" /></>, ""]}
            rows={list.map((d) => {
              const exp = expiryCell(d.rdap, d.zoneName, d.isVercel, now);
              const cert = certCell(d.tls, d.isVercel, now);
              const dns = dnsCell(d.records, d.isVercel, d.zoneName, d.vercel?.recommendedIps ?? []);
              const vc = vercelCell(d.vercel, d.isVercel);
              // "Unknown" is its own bucket: it is never counted as healthy, not even in the filter (review M4).
              const rowState = d.state === "err" || d.state === "warn" ? "warn" : d.state === "ok" ? "ok" : "unknown";
              return {
                key: d.id, state: rowState, text: `${d.name} ${d.appName ?? ""}`,
                row: (
                  <tr className={rowClass}>
                    <td className={td}>
                      <Resource kind="dom" name={d.name} />
                      {d.zoneName && <div className={sub}>Zone <Link href={`/dns?zone=${d.zoneId}`}><MaskedText text={d.zoneName} inLink /></Link></div>}
                    </td>
                    <td className={td}>{d.appId && d.appName ? <Resource kind="app" name={d.appName} href={`/apps/${d.appId}`} /> : "—"}</td>
                    <td className={td}>
                      {exp.state && exp.state !== "unknown" ? <Status state={exp.state}>{exp.text}</Status> : <span className={exp.state === "unknown" || d.isVercel ? "text-ink-faint" : ""}>{exp.text}</span>}
                      {exp.sub && <div className={sub}><MaskedText text={exp.sub} /></div>}
                    </td>
                    <td className={cn(td, tdWrap)}>
                      <span className="font-mono text-[12.5px]"><MaskedText text={dns.text} /></span>
                      {dns.proxiedToVercel && <div><Status state="warn">Proxied in front of Vercel</Status></div>}
                    </td>
                    <td className={td}><Status state={vc.state}>{vc.label}</Status></td>
                    <td className={td}>
                      {cert.state ? <Status state={cert.state}>{cert.text}</Status> : <span className="text-ink-faint">{cert.text}</span>}
                      {cert.sub && <div className={sub}><MaskedText text={cert.sub} /></div>}
                    </td>
                    <td className={td}>
                      <div className="flex gap-1.5">
                        {links && <a className={buttonClass({ size: "sm" })} href={`https://${d.name}`} target="_blank" rel="noopener noreferrer" aria-label={`Visit ${d.name}`}>Visit</a>}
                        {act && !d.isVercel && <RecheckButton domainId={d.id} name={d.name} />}
                      </div>
                    </td>
                  </tr>
                ),
              };
            })}
          />
        )}
      </Card>
      <p className="text-[12.5px] text-ink-soft">
        {"Cloudflare is read every hour, Vercel's domain settings every 6 hours, and RDAP and the certificates once a day. Re-check reads RDAP and the certificate for one domain now. A registry without an RDAP server shows \"Unknown\"."}
      </p>
    </>
  );
}
