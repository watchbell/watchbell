import { resources, snapshots } from "@/db/schema";
import { type DnsRecord, domainState, recordsFor, zoneState } from "@/lib/network/rules";
import type { SeededApps } from "./apps";
import { ago, DAY, HOUR, MINUTE, type SeedCtx } from "./context";
import type { SeededDatabases } from "./databases";
import { demoHost, ZONE_LABELS } from "./names";
import { rngFor, stableHex, stableId } from "./rng";

// Two Cloudflare zones and six app domains in them, as the stage 4 tasks write them: the zone rows with Sync's meta, the
// zone snapshot (status, name servers, SSL mode, DNS records, edge certificates, RDAP expiry), the domain rows under
// their apps (Vercel's domain list) with their TLS and Vercel config facts, and the states and reasons the real rules
// derive from those facts. One domain's certificate expires within a week (CertExpiringSoon) and the second zone's
// registration within a month (DomainExpiringSoon). Every name is under the reserved .example TLD; addresses are
// Vercel's documented apex IP or the 192.0.2.0/24 documentation range.

export type SeededZone = { id: string; name: string; expiresAt: Date };
export type SeededDomain = { id: string; name: string; appId: string; notAfter: Date };
// vercelRecord: the first zone's apex A record to Vercel (DNS only now; the resolved DnsProxiedToVercel alert is about it).
export type SeededNetwork = {
  zones: SeededZone[]; domains: SeededDomain[]; certSoon: SeededDomain; zoneSoon: SeededZone; vercelRecord: { id: string; name: string; zoneId: string };
};

const VERCEL_IP = "76.76.21.21";

export async function seedNetwork(ctx: SeedCtx, apps: SeededApps, dbs: SeededDatabases): Promise<SeededNetwork> {
  const { db, seed, now } = ctx;
  const rng = rngFor(seed, "network");
  const iso = (d: Date) => d.toISOString();
  const checked = (maxHours: number) => iso(ago(now, rng.int(10, maxHours * 60) * MINUTE));
  const cf = dbs.cloudflare;

  const labels = rng.shuffle(ZONE_LABELS).slice(0, 2);
  const zones: SeededZone[] = labels.map((label, i) => ({
    id: stableId(seed, "zone", label), name: demoHost(label),
    // The second zone's registration runs out within a month; the first has well over a year left.
    expiresAt: i === 1 ? new Date(now.getTime() + rng.int(12, 24) * DAY + rng.int(1, 20) * HOUR) : new Date(now.getTime() + rng.int(200, 600) * DAY),
  }));

  // Six domains: the first zone's apex and three of its subdomains, two subdomains of the second zone. Each belongs to an
  // app (its first word dropped: acme-shop → shop.<zone>); the apex and the first subdomain share the first app.
  const short = (name: string) => name.split("-").slice(1).join("-") || name;
  const a = apps.apps;
  const plan: { name: string; app: (typeof a)[number] }[] = [
    { name: zones[0].name, app: a[0] },
    ...[0, 1, 2].map((i) => ({ name: `${short(a[i].name)}.${zones[0].name}`, app: a[i] })),
    ...[3, 4].map((i) => ({ name: `${short(a[i % a.length].name)}.${zones[1].name}`, app: a[i % a.length] })),
  ];
  const soonIndex = rng.int(1, 3); // a subdomain of the first zone: its only problem is the certificate
  const domains: SeededDomain[] = plan.map((p, i) => ({
    id: stableId(seed, "domain", p.name), name: p.name, appId: p.app.id,
    notAfter: i === soonIndex ? new Date(now.getTime() + rng.int(4, 9) * DAY + rng.int(1, 20) * HOUR) : new Date(now.getTime() + rng.int(30, 85) * DAY),
  }));

  // DNS records: an A record to Vercel per domain (DNS only, as Vercel recommends), plus mail, SPF and a proxied
  // record that doesn't point to Vercel.
  const record = (zone: string, type: string, name: string, content: string, proxied: boolean, comment: string | null = null): DnsRecord => ({
    id: stableHex(32, seed, "dns", zone, type, name), type, name, content, proxied, ttl: proxied ? 1 : 300, comment,
  });
  const recordsOf = (z: SeededZone): DnsRecord[] => [
    ...domains.filter((d) => d.name === z.name || d.name.endsWith(`.${z.name}`)).map((d) => record(z.name, "A", d.name, VERCEL_IP, false, "Vercel")),
    record(z.name, "MX", z.name, demoHost("mx1.mail"), false),
    record(z.name, "TXT", z.name, `v=spf1 include:_spf.${demoHost("mail")} ~all`, false),
    record(z.name, "A", `legacy.${z.name}`, `192.0.2.${rng.int(10, 200)}`, true, "Old server, kept for redirects"),
  ];

  const zoneRows = zones.map((z) => {
    const records = recordsOf(z);
    const rdap = { expiresAt: iso(z.expiresAt), registrar: "Example Registrar, Inc.", error: null, checkedAt: checked(20) };
    const zoneFact = { status: "active", paused: false, nameServers: [demoHost("ada.ns"), demoHost("bob.ns")], accountId: cf.cfAccountId, checkedAt: checked(1) };
    const st = zoneState({ status: zoneFact.status, paused: zoneFact.paused, rdap }, now);
    const data = {
      zone: zoneFact, ssl: { mode: "strict", error: null }, records, recordsTruncated: false, cfErrors: [],
      certs: [{ type: "universal", status: "active", hosts: [z.name, `*.${z.name}`], expiresOn: iso(new Date(now.getTime() + rng.int(40, 80) * DAY)) }],
      rdap, reasons: st.reasons,
    };
    return { z, records, rdap, state: st.state, data };
  });

  const created = ago(now, rng.int(150, 380) * DAY);
  const synced = ago(now, rng.int(5, 50) * MINUTE);
  await db.insert(resources).values(zones.map((z) => ({
    id: z.id, accountId: cf.accountId, kind: "zone" as const, externalId: stableHex(32, seed, "zone-id", z.name), name: z.name, monitored: true,
    meta: { status: "active", accountId: cf.cfAccountId, accountName: cf.label }, firstSeenAt: created, lastSeenAt: synced, createdAt: created, updatedAt: synced,
  })));
  await db.insert(resources).values(domains.map((d) => {
    const app = a.find((x) => x.id === d.appId)!;
    return {
      id: d.id, accountId: apps.accountId, kind: "domain" as const, externalId: d.name, name: d.name, parentId: d.appId, monitored: true,
      meta: { redirect: null, verified: true, projectId: app.externalId }, firstSeenAt: created, lastSeenAt: synced, createdAt: created, updatedAt: synced,
    };
  }));

  const issuers = ["Let's Encrypt", "Google Trust Services"];
  await db.insert(snapshots).values([
    ...zoneRows.map((r) => ({ resourceId: r.z.id, state: r.state, stateSince: r.state === "ok" ? created : new Date(r.z.expiresAt.getTime() - 30 * DAY), data: r.data, collectedAt: synced })),
    ...domains.map((d) => {
      const zone = zoneRows.find((r) => d.name === r.z.name || d.name.endsWith(`.${r.z.name}`))!;
      const tls = { notAfter: iso(d.notAfter), issuer: rng.pick(issuers), authorized: true, error: null, checkedAt: checked(19) };
      const vercel = { misconfigured: false, configuredBy: "A", recommendedIps: [VERCEL_IP], checkedAt: checked(6) };
      const st = domainState({ host: d.name, tls, vercel, records: recordsFor(d.name, zone.records), zoneRdap: zone.rdap }, now);
      // Since when it needs attention: the day it crossed the first warning it has (certificate 14 days, domain 30).
      const since = st.state === "ok" ? created : new Date(Math.min(d.notAfter.getTime() - 14 * DAY, zone.z.expiresAt.getTime() - 30 * DAY));
      return { resourceId: d.id, state: st.state, stateSince: since, data: { tls, vercel, reasons: st.reasons }, collectedAt: synced };
    }),
  ]);

  const apex = zoneRows[0].records.find((r) => r.type === "A" && r.name === zones[0].name && r.content === VERCEL_IP)!;
  return { zones, domains, certSoon: domains[soonIndex], zoneSoon: zones[1], vercelRecord: { id: apex.id, name: apex.name, zoneId: zones[0].id } };
}
