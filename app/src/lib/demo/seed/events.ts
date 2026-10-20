import { sql } from "drizzle-orm";
import { events } from "@/db/schema";
import { rowsOf } from "@/db/rows";
import type { State } from "@/lib/status";
import { zoneName } from "@/lib/time";
import { hostPath } from "@/lib/view/format";
import type { SeededAlerts } from "./alerts";
import type { SeededApps } from "./apps";
import { ago, DAY, HOUR, MINUTE, type SeedCtx } from "./context";
import type { SeededDatabases } from "./databases";
import { demoUserId } from "./members";
import type { SeededNetwork } from "./network";
import { rngFor, stableId } from "./rng";
import type { SeededUptime } from "./uptime";

// The Events timeline of the last 7 days, in the collector's words (lib/collector/rules.ts, lib/network/rules.ts) with
// their reason codes: every deployment of the week (started, then ready or failed), the outage (degraded, down,
// recovered) and the monitor that is degraded now, the domain and zone that need attention, the daily job's runs, and
// the owner's own actions (the audit trail, type "action", with the visitor as the actor).

type EventRow = typeof events.$inferInsert;
const WEEK = 7 * DAY;
const DAILY_UTC_HOUR = 20; // the daily job: 03:00 WIB

export async function seedEvents(ctx: SeedCtx, apps: SeededApps, uptime: SeededUptime, dbs: SeededDatabases, net: SeededNetwork, al: SeededAlerts): Promise<void> {
  const { db, seed, now } = ctx;
  const rng = rngFor(seed, "events");
  const rows: EventRow[] = [];
  const add = (key: string, e: Omit<EventRow, "id" | "count"> & { reason: string }) => rows.push({ id: stableId(seed, "event", key), count: 1, ...e });

  // Deployments of the last week (apps.ts wrote them; times relative to now).
  const deploys = rowsOf<{ external_id: string; resource_id: string; state: string; branch: string | null; commit_sha: string | null; building_at: string | Date | null; ready_at: string | Date | null; created_at_provider: string | Date }>(
    await db.execute(sql`select external_id, resource_id, state, branch, commit_sha, building_at, ready_at, created_at_provider from ops.deployments
      where created_at_provider > ${new Date(now.getTime() - WEEK).toISOString()}::timestamptz`),
  );
  for (const d of deploys) {
    const detail = `${d.branch ?? "unknown branch"} · ${d.commit_sha ? d.commit_sha.slice(0, 7) : "no commit"}`;
    const created = new Date(d.created_at_provider);
    const started = d.building_at ? new Date(d.building_at) : created;
    add(`${d.external_id}:start`, { at: started, resourceId: d.resource_id, type: "deployment", kind: "build", message: "Deployment started", detail, reason: "DeployStarted" });
    if (d.state === "ready" && d.ready_at) add(`${d.external_id}:ready`, { at: new Date(d.ready_at), resourceId: d.resource_id, type: "deployment", kind: "ok", message: "Deployment ready", detail, reason: "DeployReady" });
    if (d.state === "error") add(`${d.external_id}:failed`, { at: new Date(started.getTime() + rng.int(40, 110) * 1000), resourceId: d.resource_id, type: "deployment", kind: "fail", message: "Deployment failed", detail, reason: "DeployFailed" });
  }

  // The outage: degraded on the first failed check, down on the third, recovered on the first good one.
  const out = uptime.outage;
  const outMon = uptime.monitors.find((m) => m.id === out.monitorId)!;
  const mon = (key: string, at: Date, appId: string, kind: State, message: string, detail: string, reason: string) =>
    add(key, { at, resourceId: appId, type: "monitor", kind, message, detail, reason });
  mon("outage:warn", out.startedAt, out.appId, "warn", "Monitor degraded", "HTTP 503", "MonitorDegraded");
  mon("outage:err", new Date(out.startedAt.getTime() + 10 * MINUTE), out.appId, "err", "Monitor down", "HTTP 503 on 3 checks in a row", "MonitorDown");
  mon("outage:ok", out.recoveredAt, out.appId, "ok", "Monitor recovered", `${outMon.path} answers again`, "MonitorRecovered");
  if (uptime.degraded) mon("degraded:warn", uptime.degraded.since, uptime.degraded.appId, "warn", "Monitor degraded", "No answer within 5 s", "MonitorDegraded");

  // Network: the domain whose certificate crossed 14 days, the zone whose registration crossed 30.
  const cert = net.certSoon;
  const zone = net.zoneSoon;
  const certAt = new Date(cert.notAfter.getTime() - 14 * DAY + rng.int(5, 50) * MINUTE);
  const zoneAt = new Date(zone.expiresAt.getTime() - 30 * DAY + rng.int(5, 50) * MINUTE);
  add("net:cert", { at: certAt, resourceId: cert.id, type: "system", kind: "warn", message: `${cert.name} needs attention`, detail: "Certificate expires in 13 days", reason: "NetworkAttention" });
  add("net:zone", { at: zoneAt, resourceId: zone.id, type: "system", kind: "warn", message: `${zone.name} needs attention`, detail: "Domain expires in 29 days", reason: "NetworkAttention" });

  // The daily job at 03:00 WIB, every day of the week.
  const lastDaily = new Date(now);
  lastDaily.setUTCHours(DAILY_UTC_HOUR, 0, 0, 0);
  if (lastDaily.getTime() > now.getTime() - 5 * MINUTE) lastDaily.setTime(lastDaily.getTime() - DAY);
  for (let i = 0; i < 7; i++) {
    const at = new Date(lastDaily.getTime() - i * DAY + rng.int(20, 90) * 1000);
    add(`daily:${i}`, { at, resourceId: null, type: "system", kind: "ok", message: "Daily jobs finished", detail: "Rollups, retention, certificates and domain expiry", reason: "DailyFinished" });
  }

  // The owner's actions (audit trail).
  const actor = demoUserId(seed);
  const act = (key: string, daysAgo: number, message: string, resourceId: string | null, detail: string | null = null) =>
    add(`action:${key}`, { at: ago(now, daysAgo * DAY + rng.int(1, 10) * HOUR + rng.int(0, 59) * MINUTE), resourceId, type: "action", kind: "ok", message, detail, actorUserId: actor, reason: "Action" });
  const health = uptime.monitors.find((m) => m.path === "/api/health") ?? uptime.monitors[0];
  const linkedApp = apps.apps[0];
  const supa = dbs.dbs.find((d) => d.kind === "supabase_project")!;
  act("monitor-added", 6, `Monitor added: ${hostPath(health.url)}`, health.appId);
  act("db-link", 5, `Database link: ${linkedApp.name} → ${supa.name}`, linkedApp.id);
  act("keep-active", 5, `Keep active on: ${supa.name}`, supa.id);
  act("rule", 4, "Alert rule edited: HighLatency", null, "threshold 1,500 ms");
  act("maintenance", 3, "Maintenance window added", null, `Sundays 02:00 ${zoneName()}, 30 min`);
  act("check-now", 1, `Check now: ${hostPath(outMon.url)}`, outMon.appId);
  // The Cloudflare token that was about to expire, replaced a few minutes before its alert resolved.
  const cred = al.resolved.credential;
  add("action:credential", {
    at: new Date(cred.resolvedAt.getTime() - rng.int(2, 9) * MINUTE), resourceId: null, type: "action", kind: "ok",
    message: `Credential replaced: ${cred.title}`, detail: "Tested and stored; it no longer expires soon", actorUserId: actor, reason: "Action",
  });
  add("action:auto-recheck", {
    at: new Date(out.startedAt.getTime() + 11 * MINUTE + 3000), resourceId: outMon.appId, type: "action", kind: "err",
    message: `Auto-actions: Check now: ${hostPath(outMon.url)}`, detail: null, actorUserId: null, reason: "Action",
  });

  await db.insert(events).values(rows.sort((x, y) => (x.at as Date).getTime() - (y.at as Date).getTime()));
}
