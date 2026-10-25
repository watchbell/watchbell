import { isRuleKey, type RuleKey } from "@/lib/alerts/catalog";
import { ACTIONS_COPY } from "@/lib/copy/edition";

// The areas (the Watchbell sidebar groups) an alert or an action proposal belongs to. Shared by the auto-actions
// module and, for now, the Virtual Office (its "rooms" are these same areas). Pure.

export type ActionArea = "workloads" | "databases" | "network" | "observe" | "ai" | "admin";
export const AREA_LABELS: Record<ActionArea, string> = {
  workloads: "Workloads", databases: "Databases", network: "Network", observe: "Observe", ai: "AI & API", admin: "Administration",
};

// Who a proposal is from, as notices and the page show it (the area's label; the editions word it: lib/copy/edition).
export const proposedBy = (area: ActionArea): string => ACTIONS_COPY.proposedBy(AREA_LABELS[area]);

export const ALARM_ROOM: Record<RuleKey, ActionArea> = {
  MonitorDown: "workloads", HighLatency: "workloads", DeploymentFailed: "workloads",
  DatabasePaused: "databases", StorageAlmostFull: "databases", NeonComputeHigh: "databases", FirestoreQuotaHigh: "databases", AutoPauseRisk: "databases", ComputeHigh: "databases", DbQuotaHigh: "databases",
  CertExpiringSoon: "network", DomainExpiringSoon: "network", DnsProxiedToVercel: "network",
  CollectorStale: "observe",
  CredentialExpiring: "admin",
  VulnerableDependency: "workloads", // Stage 9 slice 5: an app's dependencies, like its deployments
  FrameworkVulnerable: "workloads", // Watchbell 1.2: the app's Next.js version (its Security card)
  MonitorDomainMoved: "workloads", // Watchbell 1.2.1: an app's monitor on a domain it no longer has
};

const APP_RULES = new Set<string>(["MonitorDown", "HighLatency", "DeploymentFailed", "VulnerableDependency", "FrameworkVulnerable", "MonitorDomainMoved"]);

export function areaForAlert(a: { ruleKey: string; resourceKind: string | null }): ActionArea {
  if (isRuleKey(a.ruleKey)) {
    // A monitor alert is about an app; one without an app (not produced today) is an Observe matter.
    if (APP_RULES.has(a.ruleKey) && a.resourceKind !== null && a.resourceKind !== "app") return "observe";
    return ALARM_ROOM[a.ruleKey];
  }
  // By its words: "AiQuotaLow" → ai, quota, low; "api_key_expiring" → api, key, expiring.
  const words = new Set(a.ruleKey.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const has = (...w: string[]) => w.some((x) => words.has(x));
  if (has("ai", "router", "gateway", "model", "models", "provider", "quota", "llm", "gemini")) return "ai";
  if (has("key", "keys", "member", "members", "security", "audit", "credential", "credentials", "mfa", "token")) return "admin";
  if (has("database", "db", "storage", "compute", "neon", "supabase", "firestore", "firebase")) return "databases";
  if (has("domain", "domains", "dns", "cert", "certificate", "tls", "zone")) return "network";
  return a.resourceKind === "app" ? "workloads" : "observe";
}
