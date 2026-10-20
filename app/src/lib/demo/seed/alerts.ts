import { sql } from "drizzle-orm";
import { alerts } from "@/db/schema";
import { rowsOf } from "@/db/rows";
import { RULES, type RuleKey } from "@/lib/alerts/catalog";
import { daysLeft } from "@/lib/network/rules";
import { hostPath } from "@/lib/view/format";
import type { SeededApps } from "./apps";
import { ago, DAY, HOUR, MINUTE, type SeedCtx } from "./context";
import type { SeededDatabases } from "./databases";
import type { SeededNetwork } from "./network";
import { rngFor, stableHex, stableId } from "./rng";
import type { SeededUptime } from "./uptime";

// Alerts as the evaluator (lib/alerts/evaluate.ts) words them, tied to the seeded rows. Three fire now, each matching the
// data the rules read: the app whose newest production build failed (DeploymentFailed), the domain whose certificate
// expires within a week (CertExpiringSoon) and the zone whose registration runs out within a month
// (DomainExpiringSoon). About ten resolved within the last 7 days (the Resolved tab's window), the newest being the
// monitor outage of the last day; each matches the rows it is about (the latency ones the slow windows in the checks and
// rollups, the DNS one a real seeded record, the credential one an audit entry for its replacement).

export type FailedDeploy = { appId: string; appName: string; sha: string; createdAt: Date; currentExternalId: string | null };
export type SeededAlerts = {
  firing: { deploy: string; cert: string; zone: string };
  resolved: {
    outage: string;
    oldDeploy: { id: string; appId: string; appName: string; previousExternalId: string | null; startedAt: Date; resolvedAt: Date };
    credential: { title: string; resolvedAt: Date };
  };
  failedDeploy: FailedDeploy;
};

type AlertRow = typeof alerts.$inferInsert;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const num = (n: number) => n.toLocaleString("en-US");

export async function seedAlerts(ctx: SeedCtx, apps: SeededApps, uptime: SeededUptime, dbs: SeededDatabases, net: SeededNetwork): Promise<SeededAlerts> {
  const { db, seed, now } = ctx;
  const rng = rngFor(seed, "alerts");
  const id = (...path: (string | number)[]) => stableId(seed, "alert", ...path);
  const appName = (appId: string) => apps.apps.find((a) => a.id === appId)?.name ?? "app";

  // The failed build (seeded by apps.ts) and each app's current and previous production deploys.
  const deploys = rowsOf<{ resource_id: string; external_id: string; state: string; target: string; commit_sha: string; created_at_provider: string | Date; is_current: boolean; is_previous_production: boolean }>(
    await db.execute(sql`select resource_id, external_id, state, target, commit_sha, created_at_provider, is_current, is_previous_production from ops.deployments`),
  );
  const failed = deploys.find((d) => d.state === "error" && d.target === "production")!;
  const failedDeploy: FailedDeploy = {
    appId: failed.resource_id, appName: appName(failed.resource_id), sha: failed.commit_sha.slice(0, 7), createdAt: new Date(failed.created_at_provider),
    currentExternalId: deploys.find((d) => d.resource_id === failed.resource_id && d.is_current)?.external_id ?? null,
  };

  const base = (rule: RuleKey, subject: string, o: Partial<AlertRow> & Pick<AlertRow, "title" | "message" | "startedAt">): AlertRow => {
    const resolvedAt = o.resolvedAt ?? null;
    return {
      ruleKey: rule, subject, severity: RULES[rule].severity, resourceId: null, accountId: null, okStreak: resolvedAt ? 2 : 0,
      lastSeenAt: resolvedAt ?? ago(now, rng.int(5, 55) * 1000), lastSampleAt: null, notifiedOpen: RULES[rule].severity !== "info",
      lastNotifiedAt: resolvedAt ?? new Date(o.startedAt.getTime() + MINUTE), pending: null, pendingSince: null, ...o,
    };
  };

  // ---- firing ----
  const cert = net.certSoon;
  const certLeft = daysLeft(cert.notAfter, now) ?? 0;
  const zone = net.zoneSoon;
  const zoneLeft = daysLeft(zone.expiresAt, now) ?? 0;
  const firing: AlertRow[] = [
    base("DeploymentFailed", failedDeploy.appId, {
      id: id("firing", "deploy"), resourceId: failedDeploy.appId, title: failedDeploy.appName,
      message: `Production deployment ${failedDeploy.sha} failed.`, startedAt: new Date(failedDeploy.createdAt.getTime() + rng.int(60, 150) * 1000),
    }),
    base("CertExpiringSoon", cert.id, {
      id: id("firing", "cert"), resourceId: cert.id, title: cert.name, message: `The TLS certificate of ${cert.name} expires in ${plural(certLeft, "day")}.`,
      startedAt: new Date(cert.notAfter.getTime() - 14 * DAY + rng.int(5, 55) * MINUTE),
    }),
    base("DomainExpiringSoon", zone.id, {
      id: id("firing", "zone"), resourceId: zone.id, title: zone.name, message: `${zone.name} expires in ${plural(zoneLeft, "day")}.`,
      startedAt: new Date(zone.expiresAt.getTime() - 30 * DAY + rng.int(5, 55) * MINUTE),
    }),
  ];

  // ---- resolved within the last 7 days ----
  const out = uptime.outage;
  const outMon = uptime.monitors.find((m) => m.id === out.monitorId)!;
  const oldApp = apps.apps.find((a) => a.id !== failedDeploy.appId) ?? apps.apps[0];
  const db_ = (kind: string) => dbs.dbs.find((d) => d.kind === kind)!;
  const at = (daysAgo: number, hours: number) => ago(now, daysAgo * DAY + hours * HOUR + rng.int(0, 50) * MINUTE);
  const span = (start: Date, minutes: number) => new Date(start.getTime() + minutes * MINUTE);

  const latency = (key: string, w: SeededUptime["slow"][number]) => {
    const mon = uptime.monitors.find((m) => m.id === w.monitorId)!;
    return base("HighLatency", mon.id, {
      id: id("resolved", key), resourceId: mon.appId, title: `${appName(mon.appId)} ${mon.path}`,
      message: `p95 ${num(w.p95)} ms over the last 10 minutes (limit 1,500 ms).`, startedAt: w.firedAt, resolvedAt: w.resolvedAt,
    });
  };
  const oldDeploy = { start: at(4, rng.int(1, 9)), sha: stableHex(7, seed, "old-failed", oldApp.name) };
  const upstash = db_("upstash_redis");
  const fire = db_("firestore");
  const supa = db_("supabase_project");
  const cfLabel = dbs.cloudflare.label;
  const r = {
    outage: base("MonitorDown", outMon.id, {
      id: id("resolved", "outage"), resourceId: outMon.appId, title: `${appName(outMon.appId)} ${outMon.path}`,
      message: `${hostPath(outMon.url)} returned HTTP 503 on 3 consecutive checks.`,
      startedAt: new Date(out.startedAt.getTime() + 10 * MINUTE), resolvedAt: out.recoveredAt,
    }),
    latencyA: latency("latency-a", uptime.slow[0]),
    latencyB: latency("latency-b", uptime.slow[1]),
    oldDeploy: base("DeploymentFailed", oldApp.id, {
      id: id("resolved", "old-deploy"), resourceId: oldApp.id, title: oldApp.name, message: `Production deployment ${oldDeploy.sha} failed.`,
      startedAt: oldDeploy.start, resolvedAt: span(oldDeploy.start, rng.int(35, 70)),
    }),
    collector: (() => { const s = at(6, rng.int(1, 10)); return base("CollectorStale", "collector", {
      id: id("resolved", "collector"), title: "collector", message: "The last minute run finished 6 min ago.", startedAt: s, resolvedAt: span(s, rng.int(4, 9)),
    }); })(),
    autoPause: (() => { const s = at(6, rng.int(12, 20)); return base("AutoPauseRisk", supa.id, {
      id: id("resolved", "auto-pause"), resourceId: supa.id, title: supa.name,
      message: "No API traffic for 4 days. Supabase pauses free projects after about 7 days.", startedAt: s, resolvedAt: span(s, rng.int(20, 30) * 60),
    }); })(),
    quota: (() => { const s = at(6, rng.int(1, 8)); return base("DbQuotaHigh", upstash.id, {
      id: id("resolved", "db-quota"), resourceId: upstash.id, title: upstash.name, message: `${upstash.name}: Commands at ${rng.int(81, 88)}% of the free plan.`,
      startedAt: s, resolvedAt: span(s, rng.int(3, 6) * 60),
    }); })(),
    firestore: (() => { const s = at(3, rng.int(1, 6)); return base("FirestoreQuotaHigh", fire.id, {
      id: id("resolved", "firestore"), resourceId: fire.id, title: fire.name,
      message: `${fire.name} read ${num(rng.int(40_500, 46_000))} of 50,000 documents today (${rng.int(81, 92)}%).`, startedAt: s, resolvedAt: span(s, rng.int(2, 5) * 60),
    }); })(),
    // The record is DNS only now (network.ts): it was switched off the proxy, which resolved this.
    proxied: (() => { const s = at(5, rng.int(12, 20)); const rec = net.vercelRecord; return base("DnsProxiedToVercel", rec.id, {
      id: id("resolved", "proxied"), resourceId: rec.zoneId, title: rec.name,
      message: `${rec.name} points to Vercel through the Cloudflare proxy. Vercel recommends DNS only.`, startedAt: s, resolvedAt: span(s, rng.int(2, 4) * 24 * 60),
    }); })(),
    credential: (() => { const s = at(6, rng.int(14, 22)); return base("CredentialExpiring", dbs.cloudflare.accountId, {
      id: id("resolved", "credential"), accountId: dbs.cloudflare.accountId, title: `cloudflare · ${cfLabel}`,
      message: `The cloudflare credential ${cfLabel} expires in 9 days.`, startedAt: s, resolvedAt: span(s, rng.int(1, 2) * 24 * 60 + rng.int(10, 300)),
    }); })(),
  };
  await db.insert(alerts).values([...firing, ...Object.values(r)]);

  return {
    firing: { deploy: firing[0].id!, cert: firing[1].id!, zone: firing[2].id! },
    resolved: {
      outage: r.outage.id!,
      oldDeploy: {
        id: r.oldDeploy.id!, appId: oldApp.id, appName: oldApp.name,
        previousExternalId: deploys.find((d) => d.resource_id === oldApp.id && d.is_previous_production)?.external_id ?? null,
        startedAt: r.oldDeploy.startedAt, resolvedAt: r.oldDeploy.resolvedAt!,
      },
      credential: { title: r.credential.title, resolvedAt: r.credential.resolvedAt! },
    },
    failedDeploy,
  };
}
