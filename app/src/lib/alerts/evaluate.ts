// One pass of every enabled rule over the facts. Each subject gets an observation: firing, ok, or unknown (data the
// rule can't judge, which never opens or resolves anything; spec §16). A rule is "evaluated" only when its source
// exists, so open alerts of a rule whose data vanished are left alone instead of resolving.
import { RULES, type RuleConfig, type RuleKey } from "./catalog";
import { bodyFailure } from "@/lib/monitors";
import { computeBreaches, computeLimits } from "@/lib/databases/compute-metrics";
import { alertLevel, alertMessage } from "@/lib/deps/plan";
import { frameworkMessage } from "@/lib/deps/framework";
import { worstSeverity } from "@/lib/security/rules";
import type { DbFact, Facts } from "./facts";

export type Observation = {
  rule: RuleKey; subject: string; status: "firing" | "ok" | "unknown"; resourceId: string | null; accountId: string | null;
  title: string; message: string; provider: string | null; sampleAt: Date | null;
  // Stage 9 slice 5: an observation may ask for a higher severity than the rule's default (lifecycle.ts openSeverity).
  severity?: "critical";
};

const DAY = 86_400_000;
const MB = 1_000_000;
const n = (x: number) => Math.round(x).toLocaleString("en-US");
const daysLeft = (d: Date, now: Date) => Math.floor((d.getTime() - now.getTime()) / DAY);
const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
const hostPath = (url: string) => { try { const u = new URL(url); return `${u.host}${u.pathname}`; } catch { return url; } };
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const pathOf = (url: string) => { try { return new URL(url).pathname; } catch { return "/"; } };

// A down heartbeat's lastError is its state text ("Down · the job reported a failure", "Down · started but didn't
// finish", "Down · no ping for 2 h"), so the alert names the real cause (5b final review M1).
const DOWN_PREFIX = "Down · ";
const heartbeatReason = (lastError: string | null | undefined) =>
  lastError?.startsWith(DOWN_PREFIX) ? lastError.slice(DOWN_PREFIX.length) : "no ping in time";

type Ev = (f: Facts, t: number | null) => Observation[] | null; // null: source not available

const base = (rule: RuleKey, subject: string, o: Partial<Observation>): Observation => ({
  rule, subject, status: "unknown", resourceId: null, accountId: null, title: subject, message: "", provider: null, sampleAt: null, ...o,
});

// The provider an alert names (and matches with the provider status feeds): D1 is Cloudflare's.
const dbProvider = (d: DbFact) => (d.provider === "firestore" ? "firebase" : d.provider === "d1" ? "cloudflare" : d.provider);
const EXTRA_DB = new Set<DbFact["provider"]>(["turso", "upstash", "d1"]);

const EVALUATORS: Record<RuleKey, Ev> = {
  MonitorDown: (f, t) => f.monitors.map((m) => {
    const o = base("MonitorDown", m.id, { resourceId: m.appId, title: `${m.appName} ${m.kind === "heartbeat" ? m.url : pathOf(m.url)}`, provider: "vercel", sampleAt: m.lastCheckedAt });
    const limit = t ?? 3;
    if (m.kind === "heartbeat") return { ...o, status: m.state === "err" ? "firing" : m.state === "ok" ? "ok" : "unknown", message: `${m.appName} · ${m.url}: ${heartbeatReason(m.lastError)}.` };
    // 1.2.1: a detached host isn't the app being down; MonitorDomainMoved speaks for it (and resolves an open MonitorDown).
    if (m.movedTo) return { ...o, status: "ok", message: `${hostOf(m.url)} moved to ${m.movedTo}; MonitorDomainMoved takes over.` };
    if (m.failStreak >= limit) return { ...o, status: "firing", message: bodyFailure(m) ? `${hostPath(m.url)} failed its check (${bodyFailure(m)}) on ${limit} consecutive checks.` : `${hostPath(m.url)} returned ${m.lastStatus ? `HTTP ${m.lastStatus}` : "no answer"} on ${limit} consecutive checks.` };
    return { ...o, status: m.failStreak === 0 && m.lastCheckedAt ? "ok" : "unknown", message: `${hostPath(m.url)} answers again.` };
  }),
  MonitorDomainMoved: (f) => f.monitors.filter((m) => m.kind === "http").map((m) => {
    const o = base("MonitorDomainMoved", m.id, { resourceId: m.appId, title: `${m.appName} ${pathOf(m.url)}`, provider: "vercel" });
    return m.movedTo
      ? { ...o, status: "firing", message: `${hostOf(m.url)} is no longer a domain of ${m.appName}; production is on ${m.movedTo}.` }
      : { ...o, status: "ok", message: `The monitor checks ${hostOf(m.url)}, a domain of ${m.appName}.` };
  }),
  CollectorStale: (f, t) => {
    const limitMs = (t ?? 5) * 60_000;
    const last = f.lastMinuteRunAt;
    const stale = !last || f.now.getTime() - last.getTime() > limitMs;
    const message = !last ? "The collector hasn't finished a run yet." : `The last minute run finished ${n((f.now.getTime() - last.getTime()) / 60_000)} min ago.`;
    return [base("CollectorStale", "collector", { status: stale ? "firing" : "ok", title: "collector", message })];
  },
  HighLatency: (f, t) => f.monitors.filter((m) => m.kind === "http").map((m) => {
    const o = base("HighLatency", m.id, { resourceId: m.appId, title: `${m.appName} ${pathOf(m.url)}`, provider: "vercel", sampleAt: m.lastCheckedAt });
    if (m.checksLast10 < 5 || m.p95Last10 === null) return o;
    const limit = t ?? 1500;
    return { ...o, status: m.p95Last10 > limit ? "firing" : "ok", message: `p95 ${n(m.p95Last10)} ms over the last 10 minutes (limit ${n(limit)} ms).` };
  }),
  DeploymentFailed: (f) => f.apps.map((a) => {
    const o = base("DeploymentFailed", a.id, { resourceId: a.id, title: a.name, provider: "vercel" });
    const d = a.latestProduction;
    if (!d) return { ...o, status: "ok" };
    if (d.state === "error") return { ...o, status: "firing", message: `Production deployment ${d.sha ? d.sha.slice(0, 7) : "(no commit)"} failed.` };
    return { ...o, status: d.state === "building" ? "unknown" : "ok" };
  }),
  DatabasePaused: (f) => f.dbs && f.dbs.filter((d) => d.provider === "supabase").map((d) =>
    base("DatabasePaused", d.id, { resourceId: d.id, title: d.name, provider: "supabase",
      status: d.state === "unknown" ? "unknown" : d.state === "paused" ? "firing" : "ok", message: `Supabase project ${d.name} is paused.` })),
  CertExpiringSoon: (f, t) => f.domains && f.domains.map((d) => {
    const o = base("CertExpiringSoon", d.id, { resourceId: d.id, title: d.name, provider: "cloudflare" });
    if (!d.tlsNotAfter) return o;
    const left = daysLeft(d.tlsNotAfter, f.now);
    return { ...o, status: left < (t ?? 14) ? "firing" : "ok", message: `The TLS certificate of ${d.name} expires in ${plural(left, "day")}.` };
  }),
  DomainExpiringSoon: (f, t) => f.domains && f.domains.map((d) => {
    const o = base("DomainExpiringSoon", d.id, { resourceId: d.id, title: d.name, provider: "cloudflare" });
    if (!d.expiresAt) return o;
    const left = daysLeft(d.expiresAt, f.now);
    return { ...o, status: left < (t ?? 30) ? "firing" : "ok", message: `${d.name} expires in ${plural(left, "day")}.` };
  }),
  StorageAlmostFull: (f, t) => f.dbs && f.dbs.filter((d) => d.provider !== "firestore").map((d) => {
    const o = base("StorageAlmostFull", d.id, { resourceId: d.id, title: d.name, provider: dbProvider(d) });
    if (d.sizeBytes === null || !d.sizeLimitBytes) return o;
    const pct = (d.sizeBytes / d.sizeLimitBytes) * 100;
    return { ...o, status: pct > (t ?? 80) ? "firing" : "ok", message: `${d.name} uses ${n(d.sizeBytes / MB)} MB of ${n(d.sizeLimitBytes / MB)} MB (${n(pct)}%).` };
  }),
  NeonComputeHigh: (f, t) => f.dbs && f.dbs.filter((d) => d.provider === "neon").map((d) => {
    const o = base("NeonComputeHigh", d.id, { resourceId: d.id, title: d.name, provider: "neon" });
    if (d.cuHours === null) return o;
    return { ...o, status: d.cuHours > (t ?? 80) ? "firing" : "ok", message: `${d.name} used ${n(d.cuHours)} of ${n(d.cuLimit ?? 100)} CU-hours this month.` };
  }),
  FirestoreQuotaHigh: (f, t) => f.dbs && f.dbs.filter((d) => d.provider === "firestore").map((d) => {
    const o = base("FirestoreQuotaHigh", d.id, { resourceId: d.id, title: d.name, provider: "firebase" });
    if (d.quotaExhausted) return { ...o, status: "firing", message: `${d.name} hit a Firestore quota (RESOURCE_EXHAUSTED).` };
    if (d.readsToday === null || !d.readsLimit) return d.quotaExhausted === false ? { ...o, status: "ok" } : o;
    const pct = (d.readsToday / d.readsLimit) * 100;
    return { ...o, status: pct > (t ?? 80) ? "firing" : "ok", message: `${d.name} read ${n(d.readsToday)} of ${n(d.readsLimit)} documents today (${n(pct)}%).` };
  }),
  AutoPauseRisk: (f, t) => f.dbs && f.dbs.filter((d) => d.provider === "supabase").map((d) => {
    const o = base("AutoPauseRisk", d.id, { resourceId: d.id, title: d.name, provider: "supabase" });
    if (d.state === "paused") return { ...o, status: "ok" };
    if (!d.lastApiAt) return o;
    const idle = Math.floor((f.now.getTime() - d.lastApiAt.getTime()) / DAY);
    return { ...o, status: idle >= (t ?? 4) ? "firing" : "ok", message: `No API traffic for ${plural(idle, "day")}. Supabase pauses free projects after about 7 days.` };
  }),
  DnsProxiedToVercel: (f) => f.dns && f.dns.map((r) => base("DnsProxiedToVercel", r.id, {
    resourceId: r.resourceId, title: r.name, provider: "cloudflare", status: r.proxied && r.pointsToVercel ? "firing" : "ok",
    message: `${r.name} points to Vercel through the Cloudflare proxy. Vercel recommends DNS only.`,
  })),
  DbQuotaHigh: (f, t) => f.dbs && f.dbs.filter((d) => EXTRA_DB.has(d.provider)).map((d) => {
    const o = base("DbQuotaHigh", d.id, { resourceId: d.id, title: d.name, provider: dbProvider(d) });
    if (d.quotaPct == null) return o;
    return { ...o, status: d.quotaPct > (t ?? 80) ? "firing" : "ok", message: `${d.name}: ${d.quotaLabel ?? "usage"} at ${n(d.quotaPct)}% of the free plan.` };
  }),
  ComputeHigh: (f, t) => f.compute ? f.compute.map((c) => {
    const o = base("ComputeHigh", c.id, { resourceId: c.id, title: c.name, provider: "supabase", sampleAt: c.latest ? new Date(c.latest.at) : null });
    const hit = computeBreaches(c.latest, computeLimits(t), f.now);
    if (hit === null) return o;
    return { ...o, status: hit.length ? "firing" : "ok", message: hit.length ? `${c.name}: ${hit.join(", ")}.` : `${c.name} compute is back under the limits.` };
  }) : null,
  CredentialExpiring: (f, t) => f.accounts.map((a) => {
    const o = base("CredentialExpiring", a.id, { accountId: a.id, title: `${a.provider} · ${a.label}`, provider: a.provider });
    if (a.provider === "drive" && a.status === "error" && a.lastError?.includes("invalid_grant")) return { ...o, status: "firing", message: "Google Drive access was removed (invalid_grant). Reconnect it." };
    if (!a.expiresAt) return { ...o, status: "ok" };
    const left = daysLeft(a.expiresAt, f.now);
    return { ...o, status: left < (t ?? 14) ? "firing" : "ok", message: left < 0 ? `The ${a.provider} credential ${a.label} has expired.` : `The ${a.provider} credential ${a.label} expires in ${plural(left, "day")}.` };
  }),
  // Stage 9 slice 5: one subject per scanned, watched app. A failed last scan says nothing new (unknown).
  VulnerableDependency: (f) => f.deps ? f.deps.flatMap((d) => {
    const app = f.apps.find((a) => a.id === d.appId);
    if (!app) return [];
    const o = base("VulnerableDependency", d.appId, { resourceId: d.appId, title: app.name, provider: "github" });
    if (d.error) return [o];
    const level = alertLevel(d.vulns);
    if (!level) return [{ ...o, status: "ok" as const, message: `${app.name} has no moderate, high or critical dependency advisories.` }];
    return [{ ...o, status: "firing" as const, message: alertMessage(d.vulns), ...(level === "critical" ? { severity: "critical" as const } : {}) }];
  }) : null,
  // Watchbell 1.2: one subject per checked, watched app. "vulnerable" with findings fires (critical when one is); "ok"
  // resolves; a check that couldn't read the version or reach OSV.dev ("unknown", "error") says nothing new.
  FrameworkVulnerable: (f) => f.frameworks ? f.frameworks.flatMap((s) => {
    const app = f.apps.find((a) => a.id === s.appId);
    if (!app) return [];
    const o = base("FrameworkVulnerable", s.appId, { resourceId: s.appId, title: app.name });
    if (s.status === "ok") return [{ ...o, status: "ok" as const, message: `${app.name} runs Next.js ${s.version ?? "(unknown version)"} with no known advisories.` }];
    if (s.status !== "vulnerable" || !s.findings.length) return [o];
    return [{ ...o, status: "firing" as const, message: frameworkMessage(s.version, s.findings), ...(worstSeverity(s.findings) === "CRITICAL" ? { severity: "critical" as const } : {}) }];
  }) : null,
};

export function evaluate(f: Facts, rules: RuleConfig[], only?: RuleKey[]): { observations: Observation[]; evaluated: Set<RuleKey> } {
  const observations: Observation[] = [];
  const evaluated = new Set<RuleKey>();
  for (const r of rules) {
    if (!r.enabled || (only && !only.includes(r.key)) || !RULES[r.key]) continue;
    const out = EVALUATORS[r.key](f, r.threshold);
    if (!out) continue;
    evaluated.add(r.key);
    observations.push(...out);
  }
  return { observations, evaluated };
}
