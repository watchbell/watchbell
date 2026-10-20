import type { DeploymentState } from "@/lib/providers/vercel";

// Stage 6 (plan A1, A9): which Vercel action a deployment offers. Pure, so the Deployments rows, the app page and the
// server actions decide the same way: the server reads live state and calls deployRole on it before any write.

export type DeployRole = "building" | "current" | "previous" | "staged" | "preview" | "failed" | "other";
export type DeployActionLabel = "Redeploy" | "Roll back to this" | "Promote" | "Cancel" | "Promote to production";
type Facts = { id: string; state: DeploymentState; target: "production" | "preview"; createdAt: Date };
type Prod = { id: string; state: DeploymentState; createdAt: Date };

// Building beats everything. The deployment Vercel serves is current; the newest READY production deployment older
// than it is previous (Hobby can roll back to that one only); a READY production one newer than it is staged, which is
// what a roll back leaves until a promote. Without the current one in `production` nothing can be placed.
export function deployRole(d: Facts, currentId: string | null, production: Prod[]): DeployRole {
  if (d.state === "building") return "building";
  if (currentId !== null && d.id === currentId) return "current";
  if (d.state === "error") return "failed";
  // Slice 2: only a READY preview can be promoted to production.
  if (d.target === "preview") return d.state === "ready" ? "preview" : "other";
  if (d.state !== "ready" || currentId === null) return "other";
  const current = production.find((p) => p.id === currentId);
  if (!current) return "other";
  if (d.createdAt.getTime() > current.createdAt.getTime()) return "staged";
  const previous = production
    .filter((p) => p.state === "ready" && p.id !== currentId && p.createdAt.getTime() < current.createdAt.getTime())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return previous?.id === d.id ? "previous" : "other";
}

// The mockup's depRow(): the row adds Visit (when there is a URL) and View build logs (building) itself. While the app
// is rolled back (it has a staged deployment) the current one offers no Redeploy: the build would stay staged, and
// redeployAction refuses it.
export function actionsFor(role: DeployRole, rolledBack = false): DeployActionLabel[] {
  switch (role) {
    case "building": return ["Cancel"];
    case "current": return rolledBack ? [] : ["Redeploy"];
    case "previous": return ["Roll back to this"];
    case "staged": return ["Promote"];
    // Slice 2 (B1): a ready preview can be promoted, which builds it again for production. While rolled back that build
    // would stay staged, so it isn't offered (promotePreviewAction refuses it too).
    case "preview": return rolledBack ? [] : ["Promote to production"];
    default: return [];
  }
}

// A3: the confirm dialog's copy, word for word from the mockup's confirmFor(). `app` is the (possibly masked) app name,
// `sha` the short commit. "Roll back" is the app page's entry (to the previous one); the rows say "Roll back to this".
export type DeployConfirm = { title: string; body: string; cta: string; danger: boolean };
export function confirmCopy(label: DeployActionLabel | "Roll back", app: string, sha: string): DeployConfirm {
  switch (label) {
    case "Redeploy": return {
      title: `Redeploy ${app}?`, cta: "Redeploy", danger: false,
      body: "Vercel builds the current production deployment again (same commit, today's environment variables) and makes it live when the build is ready. It counts toward the 100 deployments a day on Hobby.",
    };
    case "Roll back": return {
      title: `Roll back ${app}?`, cta: "Roll back", danger: true,
      body: "Production goes back to the previous production deployment. Hobby can't go further back. Vercel then stops sending new pushes to production until you promote one again.",
    };
    case "Roll back to this": return {
      title: `Roll back ${app} to ${sha || "this deployment"}?`, cta: "Roll back", danger: true,
      body: "Production goes back to this deployment. Hobby only allows the previous production deployment. Vercel then stops sending new pushes to production until you promote one again.",
    };
    case "Promote": return {
      title: `Promote ${app} ${sha}?`.replace(" ?", "?"), cta: "Promote", danger: false,
      body: "Production traffic moves to this production deployment and new pushes go live again (this undoes a roll back). Nothing is rebuilt.",
    };
    case "Promote to production": return {
      title: `Promote ${app} ${sha} to production?`.replace("  ", " "), cta: "Promote to production", danger: true,
      body: "Vercel builds this preview's commit again as a production deployment, with the production environment variables (preview-only values aren't used), and makes it live when the build is ready. It counts toward the 100 deployments a day on Hobby.",
    };
    case "Cancel": return {
      title: "Cancel this build?", cta: "Cancel build", danger: true,
      body: `The running build of ${`${app} ${sha}`.trim()} stops. The current production deployment stays live.`,
    };
  }
}

// Console rows (ops.deployments) for the UI: external ids, the stored state string and the collector's isCurrent.
type Row = { externalId: string; appId: string; state: string; target: string | null; createdAt: Date; isCurrent: boolean };

const asState = (s: string): DeploymentState => (s === "ready" || s === "building" || s === "error" || s === "canceled" ? s : "building");
const facts = (r: Row): Facts => ({ id: r.externalId, state: asState(r.state), target: r.target === "production" ? "production" : "preview", createdAt: r.createdAt });

function byApp(rows: Row[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const r of rows) out.set(r.appId, [...(out.get(r.appId) ?? []), r]);
  return out;
}

// Each row's role, placed among the rows of its own app. Keyed by external id.
export function rowRoles(rows: Row[]): Map<string, DeployRole> {
  const out = new Map<string, DeployRole>();
  for (const list of byApp(rows).values()) {
    const currentId = list.find((r) => r.isCurrent)?.externalId ?? null;
    const production = list.filter((r) => r.target === "production").map(facts);
    for (const r of list) out.set(r.externalId, deployRole(facts(r), currentId, production));
  }
  return out;
}

// The app page: what Redeploy, Roll back and the rolled-back banner's Promote act on (rows of one app).
export function appDeployTargets(rows: Row[]): { currentId: string | null; previousId: string | null; stagedId: string | null } {
  const roles = rowRoles(rows);
  const newestFirst = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const first = (role: DeployRole) => newestFirst.find((r) => roles.get(r.externalId) === role)?.externalId ?? null;
  return { currentId: first("current"), previousId: first("previous"), stagedId: first("staged") };
}
