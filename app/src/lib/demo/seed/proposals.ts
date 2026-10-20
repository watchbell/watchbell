import { sql } from "drizzle-orm";
import { hostPath } from "@/lib/view/format";
import type { SeededAlerts } from "./alerts";
import { ago, HOUR, MINUTE, type SeedCtx } from "./context";
import { memberRowId } from "./members";
import type { SeededNetwork } from "./network";
import { rngFor, stableId } from "./rng";
import type { SeededUptime } from "./uptime";

// Auto-actions (ops.action_proposals, the private feature's table; written with SQL so the core seed imports nothing
// from src/private): four proposals tied to the seeded alerts. Pending and safe (re-check the certificate that expires
// soon), pending and risky (redeploy the app whose build failed), done by auto-run (re-check the monitor during its
// outage) and rejected (roll back after an older failed build, proposed and turned down while its alert was firing). The
// two pending ones expire 2 hours after they were made.

const TTL_MS = 2 * HOUR; // PROPOSAL_TTL_MS

type Row = {
  id: string; alertId: string; ruleKey: string; room: string; action: string; risk: "safe" | "risky"; title: string; reason: string;
  resourceKind: string; resourceId: string; resourceName: string; targetRef: string | null; proposedBy: string;
  status: "pending" | "done" | "rejected"; auto: boolean; result: string | null; decidedBy: string | null;
  createdAt: Date; decidedAt: Date | null; expiresAt: Date; claimedAt: Date | null; finishedAt: Date | null;
};

export async function seedProposals(ctx: SeedCtx, al: SeededAlerts, net: SeededNetwork, uptime: SeededUptime): Promise<void> {
  const { db, seed, now } = ctx;
  const rng = rngFor(seed, "proposals");
  const id = (name: string) => stableId(seed, "proposal", name);
  const cert = net.certSoon;
  const fd = al.failedDeploy;
  const outMon = uptime.monitors.find((m) => m.id === uptime.outage.monitorId)!;
  const recheckAt = new Date(uptime.outage.startedAt.getTime() + 11 * MINUTE);
  const old = al.resolved.oldDeploy;
  // Proposed a few minutes after its alert started, turned down well before the alert resolved (35+ minutes in).
  const rejectedMade = new Date(old.startedAt.getTime() + rng.int(2, 6) * MINUTE);
  const rejectedAt = new Date(rejectedMade.getTime() + rng.int(3, 15) * MINUTE);
  const pendingSafe = ago(now, rng.int(20, 55) * MINUTE);
  const pendingRisky = ago(now, rng.int(8, 19) * MINUTE);

  const rows: Row[] = [
    {
      id: id("pending-safe"), alertId: al.firing.cert, ruleKey: "CertExpiringSoon", room: "network", action: "domain_recheck", risk: "safe",
      title: `Re-check the certificate of ${cert.name}`, reason: "The TLS certificate expires within 14 days; a fresh read shows whether it was already renewed.",
      resourceKind: "domain", resourceId: cert.id, resourceName: cert.name, targetRef: cert.id, proposedBy: "Network",
      status: "pending", auto: false, result: null, decidedBy: null, createdAt: pendingSafe, decidedAt: null, expiresAt: new Date(pendingSafe.getTime() + TTL_MS),
      claimedAt: null, finishedAt: null,
    },
    {
      id: id("pending-risky"), alertId: al.firing.deploy, ruleKey: "DeploymentFailed", room: "workloads", action: "vercel_redeploy", risk: "risky",
      title: `Redeploy production ${fd.appName}`, reason: `Production deployment ${fd.sha} failed; the previous build is still live.`,
      resourceKind: "app", resourceId: fd.appId, resourceName: fd.appName, targetRef: fd.currentExternalId, proposedBy: "Workloads",
      status: "pending", auto: false, result: null, decidedBy: null, createdAt: pendingRisky, decidedAt: null, expiresAt: new Date(pendingRisky.getTime() + TTL_MS),
      claimedAt: null, finishedAt: null,
    },
    {
      id: id("done-auto"), alertId: al.resolved.outage, ruleKey: "MonitorDown", room: "workloads", action: "recheck", risk: "safe",
      title: `Check ${hostPath(outMon.url)} again now`, reason: "It returned HTTP 503 on 3 consecutive checks.",
      resourceKind: "app", resourceId: outMon.appId, resourceName: hostPath(outMon.url), targetRef: outMon.id, proposedBy: "Workloads",
      status: "done", auto: true, result: "Failed: HTTP 503.", decidedBy: null,
      createdAt: recheckAt, decidedAt: recheckAt, expiresAt: new Date(recheckAt.getTime() + TTL_MS),
      claimedAt: new Date(recheckAt.getTime() + 2000), finishedAt: new Date(recheckAt.getTime() + 2000 + rng.int(300, 1500)),
    },
    {
      id: id("rejected"), alertId: old.id, ruleKey: "DeploymentFailed", room: "workloads", action: "vercel_rollback", risk: "risky",
      title: `Roll back ${old.appName} to the previous deployment`, reason: "The newest production build failed.",
      resourceKind: "app", resourceId: old.appId, resourceName: old.appName, targetRef: old.previousExternalId, proposedBy: "Workloads",
      status: "rejected", auto: false, result: null, decidedBy: memberRowId(seed),
      createdAt: rejectedMade, decidedAt: rejectedAt, expiresAt: new Date(rejectedMade.getTime() + TTL_MS),
      claimedAt: null, finishedAt: null,
    },
  ];

  for (const r of rows) {
    const t = (d: Date | null) => (d ? d.toISOString() : null);
    await db.execute(sql`
      insert into ops.action_proposals (id, alert_id, rule_key, room, action, risk, title, reason, resource_kind, resource_id, resource_name, target_ref,
        proposed_by, status, auto, result, decided_by, created_at, decided_at, expires_at, claimed_at, finished_at)
      values (${r.id}::uuid, ${r.alertId}::uuid, ${r.ruleKey}, ${r.room}, ${r.action}, ${r.risk}, ${r.title}, ${r.reason}, ${r.resourceKind},
        ${r.resourceId}::uuid, ${r.resourceName}, ${r.targetRef}, ${r.proposedBy}, ${r.status}, ${r.auto}, ${r.result}, ${r.decidedBy}::uuid,
        ${t(r.createdAt)}::timestamptz, ${t(r.decidedAt)}::timestamptz, ${t(r.expiresAt)}::timestamptz, ${t(r.claimedAt)}::timestamptz, ${t(r.finishedAt)}::timestamptz)`);
  }
}
