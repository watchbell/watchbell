import { chooseProductionDomain, type ProjectDomain } from "@/lib/providers/vercel";

// Watchbell 1.2.1: domain-change awareness. When an app moves to a new domain, a monitor still checking the old one is
// "Domain changed: old → new", not Down, and never a reason to redeploy. Sync and the 6-hourly `domains` task store the
// project's domains on the app (resources.meta.domains / primaryDomain); everything here is pure.

export type AppDomainsMeta = { domains: string[]; primaryDomain: string; pastDomains: string[] };
const PAST_MAX = 20;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0).map((x) => x.toLowerCase()) : []);

// What is stored on the app. `domains` is every name listed on the project, verified or not (a fresh move is pending
// verification for a while and must still count as attached), redirects included (they still belong to the project).
// pastDomains (coordinator ruling): names the project listed before and no longer does, newest last, at most 20; the
// evidence that a monitor's host is an old domain of the app.
export function appDomainsMeta(list: ProjectDomain[], projectName: string, productionAliases: string[] = [], old?: Record<string, unknown> | null): AppDomainsMeta {
  const domains = [...new Set(list.map((d) => d.name.toLowerCase()))];
  const now = new Set(domains);
  const past = [...new Set([...strings(old?.pastDomains), ...strings(old?.domains)])].filter((n) => !now.has(n)).slice(-PAST_MAX);
  return { domains, primaryDomain: chooseProductionDomain(list, projectName, productionAliases).toLowerCase(), pastDomains: past };
}

// The stored domains of an app, or null when Watchbell has none yet (an app synced before 1.2.1, or a non-Vercel row):
// then nothing here changes the existing behaviour.
export function storedDomains(meta: Record<string, unknown> | null | undefined): AppDomainsMeta | null {
  const primary = typeof meta?.primaryDomain === "string" && meta.primaryDomain ? meta.primaryDomain.toLowerCase() : null;
  if (!primary) return null;
  return { primaryDomain: primary, domains: strings(meta?.domains), pastDomains: strings(meta?.pastDomains) };
}

export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

export type DomainApp = { name: string; meta: Record<string, unknown> | null | undefined };

// "Attached": the host is the app's primary domain, one of its listed domains, its <name>.vercel.app or a vercel.app
// alias of the project (<name>-….vercel.app), or a domain another watched project lists (a shared domain: the attached
// check is per project, but a host some watched project serves is not "moved"). An app without stored domains: attached.
export function hostAttached(host: string, app: DomainApp, others: DomainApp[] = []): boolean {
  const own = storedDomains(app.meta);
  if (!own) return true;
  const h = host.toLowerCase();
  if (h === own.primaryDomain || own.domains.includes(h)) return true;
  const name = app.name.toLowerCase();
  // Review T3 M1: "shop-admin.vercel.app" is the watched app shop-admin's, not an alias of shop.
  const otherVercel = h.endsWith(".vercel.app") && others.some((o) => {
    const n = o.name.toLowerCase();
    return n !== name && n.startsWith(`${name}-`) && (h === `${n}.vercel.app` || h.startsWith(`${n}-`));
  });
  if (!otherVercel && (h === `${name}.vercel.app` || (h.endsWith(".vercel.app") && h.startsWith(`${name}-`)))) return true;
  return others.some((o) => {
    const d = storedDomains(o.meta);
    return d !== null && (d.primaryDomain === h || d.domains.includes(h));
  });
}

export type DomainMove = { from: string; to: string };

// What the last check said: Vercel's DEPLOYMENT_NOT_FOUND (lib/collector/http-check.ts) is in its error text.
export type CheckEvidence = { lastError?: string | null };
const vercelNotFound = (e: CheckEvidence) => / · DEPLOYMENT_NOT_FOUND$/.test(e.lastError ?? "");

// The move to show for an HTTP monitor (coordinator ruling): its host is no longer attached, the app has a primary
// domain, AND there is evidence the host was the app's: the project listed it before (pastDomains), or Vercel itself
// answers that no deployment serves it. A host the project never listed that isn't Vercel's stays a normal check, so
// a real outage of another server is never hidden.
export function domainMove(url: string, app: DomainApp, others: DomainApp[] = [], evidence: CheckEvidence = {}): DomainMove | null {
  const host = hostOf(url);
  const own = storedDomains(app.meta);
  if (!host || !own || hostAttached(host, app, others)) return null;
  if (!own.pastDomains.includes(host) && !vercelNotFound(evidence)) return null;
  return { from: host, to: own.primaryDomain };
}

// The monitor URL on the new host over https, keeping the path and query, without a port. Throws when the host can't
// be set (review T3 M4), so a bad name never reads as a successful update.
export function movedUrl(url: string, newHost: string): string {
  const u = new URL(url);
  u.protocol = "https:";
  u.hostname = newHost;
  u.port = "";
  if (u.hostname !== newHost.toLowerCase()) throw new Error("The new domain isn't a valid host name.");
  return u.toString();
}

// monitor id → its move, for the HTTP monitors among these whose host no watched project lists any more. `apps`: every
// watched app with its stored domains (the monitor's own app is skipped as an "other").
export function monitorMoves(
  mons: { id: string; kind: string; url: string; appId: string; appName: string; appMeta: Record<string, unknown> | null | undefined; lastError?: string | null }[],
  apps: { id: string; name: string; meta: Record<string, unknown> | null | undefined }[],
): Map<string, DomainMove> {
  const out = new Map<string, DomainMove>();
  for (const m of mons) {
    if (m.kind === "heartbeat") continue;
    const move = domainMove(m.url, { name: m.appName, meta: m.appMeta }, apps.filter((a) => a.id !== m.appId), { lastError: m.lastError });
    if (move) out.set(m.id, move);
  }
  return out;
}

// Review T3 I2: evidence (b) made sticky. A monitor seen as moved through Vercel's DEPLOYMENT_NOT_FOUND gets its host
// recorded in its app's pastDomains (evidence a), so one timeout or 5xx in between doesn't turn it back into
// MonitorDown and a redeploy or rollback proposal. Returns app id → its new pastDomains, only for apps that change.
export function stickyPastDomains(
  mons: Parameters<typeof monitorMoves>[0],
  apps: { id: string; name: string; meta: Record<string, unknown> | null | undefined }[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of mons) {
    if (m.kind === "heartbeat" || !vercelNotFound({ lastError: m.lastError })) continue;
    const own = storedDomains(m.appMeta);
    const host = hostOf(m.url);
    if (!own || !host) continue;
    const past = out.get(m.appId) ?? own.pastDomains;
    if (past.includes(host)) continue;
    if (!domainMove(m.url, { name: m.appName, meta: m.appMeta }, apps.filter((a) => a.id !== m.appId), { lastError: m.lastError })) continue;
    out.set(m.appId, [...past, host].slice(-PAST_MAX));
  }
  return out;
}
