import "server-only";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, links, resources, snapshots } from "@/db/schema";
import type { State } from "@/lib/status";
import { type AliasBook, dbAlias, hideEmails } from "@/lib/view/display-name";
import { lastDeployText, pct } from "@/lib/view/format";
import { appStatus, STATE_WORD, worstMonitor } from "@/lib/view/labels";
import { certCell, dnsCell, expiryCell } from "@/lib/view/network";
import type { TopoFact, TopoNode } from "@/lib/view/topology";
import { listApps } from "./apps-db";
import { type DomainView, listDomains } from "./network-db";

const DB_KINDS = ["supabase_project", "neon_project", "firestore", "turso_database", "upstash_redis", "d1_database"] as const;
const PROVIDER = { supabase_project: "Supabase", neon_project: "Neon", firestore: "Firebase", turso_database: "Turso", upstash_redis: "Upstash", d1_database: "Cloudflare D1" } as const;
const PAGE = { supabase_project: "/supabase", neon_project: "/neon", firestore: "/firebase", turso_database: "/turso", upstash_redis: "/upstash", d1_database: "/d1" } as const;

// App → database edges: stage 3's ops.links (kind 'uses_db', one database per app). Only links to a database the
// console still watches, the same rule as the app page's Database row (databases-db.ts linkedDatabases).
export async function appDbLinks(): Promise<{ appId: string; dbId: string }[]> {
  return db().select({ appId: links.fromResourceId, dbId: links.toResourceId }).from(links)
    .innerJoin(resources, eq(resources.id, links.toResourceId))
    .where(and(eq(links.kind, "uses_db"), eq(resources.monitored, true), isNull(resources.goneAt)))
    .limit(500);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Drawer rows per kind (mockup showNode): domain → Zone, Expires, DNS, Proxy, Certificate; app → Status, Domain,
// Database, Uptime, Last deploy; database → Provider, Status.
function domainFacts(d: DomainView, now: Date): TopoFact[] {
  const exp = expiryCell(d.rdap, d.zoneName, d.isVercel, now);
  const cert = certCell(d.tls, d.isVercel, now);
  const dns = dnsCell(d.records, d.isVercel, d.zoneName, d.vercel?.recommendedIps ?? []);
  const proxied = d.records.some((r) => r.proxied);
  return [
    { label: "Zone", value: d.zoneName ?? "Vercel's domain" },
    { label: "Expires", value: d.isVercel ? "—" : [exp.text, exp.sub].filter(Boolean).join(" · ") },
    { label: "DNS", value: dns.text, mono: true },
    proxied ? { label: "Proxy", value: "Proxied", state: dns.proxiedToVercel ? "warn" : "info" } : { label: "Proxy", value: "DNS only", state: "off" },
    cert.state && cert.state !== "unknown" ? { label: "Certificate", value: cert.text, state: cert.state } : { label: "Certificate", value: cert.text },
  ];
}

// Privacy: a database node shows its alias (`alias`; the drawer reveals `name` on click), the Database fact lists
// aliases, and account labels lose their emails.
export async function topologyColumns(now: Date, book: AliasBook): Promise<[TopoNode[], TopoNode[], TopoNode[]]> {
  const apps = (await listApps(now)).filter((a) => !a.gone);
  const dbs = await db().select({ r: resources, s: snapshots, label: accounts.label }).from(resources)
    .innerJoin(accounts, eq(accounts.id, resources.accountId)).leftJoin(snapshots, eq(snapshots.resourceId, resources.id))
    .where(and(inArray(resources.kind, [...DB_KINDS]), eq(resources.monitored, true), isNull(resources.goneAt))).orderBy(asc(resources.name)).limit(200);
  const edges = await appDbLinks();
  const domains = await listDomains();
  const watched = new Set(dbs.map(({ r }) => r.id));
  const appOrder = new Map(apps.map((a, i) => [a.id, i]));
  const domCol: TopoNode[] = domains
    .filter((d) => d.appId && appOrder.has(d.appId))
    .sort((a, b) => appOrder.get(a.appId!)! - appOrder.get(b.appId!)! || a.name.localeCompare(b.name))
    .map((d) => ({
      key: `dom:${d.id}`, kind: "dom", name: d.name, sub: d.zoneName ? "Cloudflare" : "Vercel", state: d.state, href: "/domains",
      links: [`app:${d.appId}`], facts: domainFacts(d, now),
    }));
  const appCol: TopoNode[] = apps.map((a) => {
    const s = appStatus(a);
    const dbIds = edges.filter((l) => l.appId === a.id).map((l) => l.dbId);
    const worst = worstMonitor(a.monitors);
    const jobOnly = s.state === "warn" && worst?.kind === "heartbeat";
    return {
      // U5: the shown state (appStatus), so an app under planned maintenance isn't drawn red.
      key: `app:${a.id}`, kind: "app", name: a.name, sub: "Vercel", state: s.state, href: `/apps/${a.id}`,
      links: dbIds.map((id) => `db:${id}`),
      facts: [
        { label: "Status", value: s.label, state: s.state },
        ...(jobOnly ? [{ label: "Note", value: "The website is up; a background job isn't reporting." }] : []),
        { label: "Domain", value: a.domain, mono: true },
        { label: "Database", value: dbIds.filter((id) => watched.has(id)).map((id) => dbAlias(book, id)).join(", ") || "None" },
        { label: "Uptime", value: pct(a.uptime30), mono: true },
        { label: "Last deploy", value: lastDeployText(a.lastDeploy, now) },
      ],
    };
  });
  const firstApp = (dbId: string) => Math.min(...edges.filter((l) => l.dbId === dbId).map((l) => appOrder.get(l.appId) ?? 1e9), 1e9);
  const dbCol: TopoNode[] = dbs
    .sort((a, b) => firstApp(a.r.id) - firstApp(b.r.id) || a.r.name.localeCompare(b.r.name))
    .map(({ r, s, label }) => {
      const kind = r.kind as (typeof DB_KINDS)[number];
      const state: State = s?.state ?? "unknown";
      const account = hideEmails(label);
      return {
        key: `db:${r.id}`, kind: kind === "firestore" ? "fs" : "db", name: r.name, alias: dbAlias(book, r.id), sub: `${PROVIDER[kind]} · ${account}`, state, href: PAGE[kind], links: [],
        facts: [{ label: "Provider", value: `${PROVIDER[kind]} · ${account}` }, { label: "Status", value: cap(STATE_WORD[state]), state }],
      };
    });
  return [domCol, appCol, dbCol];
}
