import "server-only";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, resources, settings, snapshots } from "@/db/schema";
import { rdapForZone, refreshNetworkStates, tlsForDomain } from "@/lib/collector/network";
import { factsOf } from "@/lib/network/facts";
import { isVercelHost, recordsFor, zoneFor, type DnsRecord, type RdapFact, type TlsFact, type VercelFact } from "@/lib/network/rules";
import { EOL_SETTINGS_KEY, parseEol, type EolData } from "@/lib/security/eol";
import type { State } from "@/lib/status";

export type DomainView = {
  id: string; name: string; appId: string | null; appName: string | null; zoneId: string | null; zoneName: string | null; isVercel: boolean;
  state: State; reasons: string[]; tls: TlsFact | null; vercel: VercelFact | null; records: DnsRecord[]; rdap: RdapFact | null;
  cfAccountId: string | null; // the zone's Cloudflare account id, for the app page's "Open in → Cloudflare" (Task 7)
};
// accountId (slice 2): the DNS records page reads that account's write access (the Access hint). Always set by
// getZoneView; optional only so older hand-built views (tests under src/private, another agent's area) still type-check.
export type ZoneView = { id: string; name: string; accountId?: string; accountLabel: string; state: State; reasons: string[]; facts: ReturnType<typeof factsOf> };

const LIMIT = 200; // R8

async function watchedZones() {
  return db().select({ r: resources, s: snapshots, label: accounts.label }).from(resources)
    .innerJoin(accounts, eq(accounts.id, resources.accountId))
    .leftJoin(snapshots, eq(snapshots.resourceId, resources.id))
    .where(and(eq(resources.kind, "zone"), eq(resources.monitored, true), isNull(resources.goneAt)))
    .orderBy(asc(resources.name)).limit(LIMIT);
}

// Every domain of a watched app, with the facts of the Cloudflare zone it sits in.
export async function listDomains(): Promise<DomainView[]> {
  const doms = await db().select({ r: resources, s: snapshots }).from(resources)
    .leftJoin(snapshots, eq(snapshots.resourceId, resources.id))
    .where(and(eq(resources.kind, "domain"), eq(resources.monitored, true), isNull(resources.goneAt)))
    .orderBy(asc(resources.name)).limit(LIMIT);
  if (!doms.length) return [];
  const appIds = [...new Set(doms.map((d) => d.r.parentId).filter((x): x is string => !!x))];
  const apps = appIds.length ? await db().select({ id: resources.id, name: resources.name, monitored: resources.monitored, goneAt: resources.goneAt }).from(resources).where(inArray(resources.id, appIds)) : [];
  // Until the next 6-hourly read unwatches them, the domains of an app the owner just unticked or that is gone don't show (review M9).
  const watchedApp = new Set(apps.filter((a) => a.monitored && !a.goneAt).map((a) => a.id));
  const zones = await watchedZones();
  const names = zones.map((z) => z.r.name);
  return doms.filter(({ r }) => !r.parentId || watchedApp.has(r.parentId)).map(({ r, s }) => {
    const f = factsOf(s?.data);
    const zoneName = zoneFor(r.name, names);
    const zone = zones.find((z) => z.r.name === zoneName);
    const zf = factsOf(zone?.s?.data);
    return {
      id: r.id, name: r.name, appId: r.parentId, appName: apps.find((a) => a.id === r.parentId)?.name ?? null,
      zoneId: zone?.r.id ?? null, zoneName, isVercel: isVercelHost(r.name),
      state: s?.state ?? "unknown", reasons: f.reasons, tls: f.tls, vercel: f.vercel,
      records: zone ? recordsFor(r.name, zf.records) : [], rdap: zone ? zf.rdap : null,
      cfAccountId: zone ? zf.zone?.accountId ?? null : null,
    };
  });
}

export async function listZoneOptions(): Promise<{ id: string; name: string }[]> {
  return (await watchedZones()).map((z) => ({ id: z.r.id, name: z.r.name }));
}

export async function getZoneView(id: string | null): Promise<ZoneView | null> {
  const zones = await watchedZones();
  const z = (id ? zones.find((x) => x.r.id === id) : null) ?? zones[0];
  if (!z) return null;
  const facts = factsOf(z.s?.data);
  return { id: z.r.id, name: z.r.name, accountId: z.r.accountId, accountLabel: z.label, state: z.s?.state ?? "unknown", reasons: facts.reasons, facts };
}

export async function readEol(): Promise<EolData | null> {
  const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, EOL_SETTINGS_KEY)).limit(1);
  const v = row?.value as { cycles?: unknown; checkedAt?: unknown } | undefined;
  const cycles = v ? parseEol({ result: { releases: (v.cycles as unknown[] | undefined)?.map((c) => {
    const x = c as { name: string; isEol: boolean; eolFrom: string | null; latest: string | null };
    return { name: x.name, isEol: x.isEol, eolFrom: x.eolFrom, latest: x.latest ? { name: x.latest } : null };
  }) } }) : null;
  return cycles && typeof v?.checkedAt === "string" ? { cycles, checkedAt: v.checkedAt } : null;
}

// Domains → Re-check (Operator and up): the certificate now, and RDAP for the zone it sits in. Console rows only.
export async function recheckDomain(domainId: string): Promise<{ ok: true; message: string; audit: { message: string; resourceId: string } } | { ok: false; error: string }> {
  const [d] = await db().select().from(resources)
    .where(and(eq(resources.id, domainId), eq(resources.kind, "domain"), eq(resources.monitored, true), isNull(resources.goneAt))).limit(1);
  if (!d) return { ok: false, error: "That domain is no longer watched." };
  if (isVercelHost(d.name)) return { ok: false, error: "vercel.app domains are Vercel's own. There is nothing to check." };
  const now = new Date();
  await tlsForDomain(d.id, d.name, now);
  const zones = await watchedZones();
  const zoneName = zoneFor(d.name, zones.map((z) => z.r.name));
  const zone = zones.find((z) => z.r.name === zoneName);
  const rdapError = zone ? await rdapForZone(zone.r.id, zone.r.name, now) : null;
  await refreshNetworkStates(now);
  const message = rdapError ? `Checked ${d.name}. Domain expiry: ${rdapError}.` : `Checked ${d.name}.`;
  return { ok: true, message, audit: { message: `Re-check: ${d.name}`, resourceId: d.id } };
}
