// Spec §10: the 13 rules (+ Stage 12 ComputeHigh, Stage 9 slice 5 VulnerableDependency, Stage 8 DbQuotaHigh), their defaults and the mockup's condition text. The database copy (ops.alert_rules) holds the
// owner's edits: severity, the one threshold, the channels and on/off.
import type { ChannelKind, Severity } from "@/db/schema";

export type RuleKey =
  | "MonitorDown" | "CollectorStale" | "HighLatency" | "DeploymentFailed" | "DatabasePaused" | "CertExpiringSoon" | "DomainExpiringSoon"
  | "StorageAlmostFull" | "NeonComputeHigh" | "FirestoreQuotaHigh" | "AutoPauseRisk" | "DnsProxiedToVercel" | "CredentialExpiring"
  | "ComputeHigh" | "DbQuotaHigh"
  | "VulnerableDependency" | "FrameworkVulnerable" | "MonitorDomainMoved";

export type RuleDef = {
  key: RuleKey; severity: Severity; threshold: number | null; bounds: [number, number] | null; source: "own" | "api" | "test";
  needs: "databases" | "domains" | "dns" | null; sampled: boolean; condition: (n: number | null) => string;
};

const num = (n: number | null) => (n ?? 0).toLocaleString("en-US");

export const RULES: Record<RuleKey, RuleDef> = {
  MonitorDown: { key: "MonitorDown", severity: "critical", threshold: 3, bounds: [1, 10], source: "own", needs: null, sampled: true, condition: (n) => `${num(n)} failed checks in a row` },
  CollectorStale: { key: "CollectorStale", severity: "critical", threshold: 5, bounds: [3, 60], source: "own", needs: null, sampled: false, condition: (n) => `No collector run for ${num(n)} min` },
  HighLatency: { key: "HighLatency", severity: "warning", threshold: 1500, bounds: [100, 30_000], source: "own", needs: null, sampled: true, condition: (n) => `Slowest 5% of checks over ${num(n)} ms for 10 min` },
  DeploymentFailed: { key: "DeploymentFailed", severity: "warning", threshold: null, bounds: null, source: "api", needs: null, sampled: false, condition: () => "A production deploy fails" },
  DatabasePaused: { key: "DatabasePaused", severity: "warning", threshold: null, bounds: null, source: "api", needs: "databases", sampled: false, condition: () => "Supabase pauses the project" },
  CertExpiringSoon: { key: "CertExpiringSoon", severity: "warning", threshold: 14, bounds: [1, 90], source: "own", needs: "domains", sampled: false, condition: (n) => `TLS certificate expires in < ${num(n)} days` },
  DomainExpiringSoon: { key: "DomainExpiringSoon", severity: "warning", threshold: 30, bounds: [1, 180], source: "api", needs: "domains", sampled: false, condition: (n) => `Domain expires in < ${num(n)} days` },
  StorageAlmostFull: { key: "StorageAlmostFull", severity: "warning", threshold: 80, bounds: [10, 100], source: "api", needs: "databases", sampled: false, condition: (n) => `Database size > ${num(n)}% of free limit` },
  NeonComputeHigh: { key: "NeonComputeHigh", severity: "warning", threshold: 80, bounds: [1, 100], source: "api", needs: "databases", sampled: false, condition: (n) => `> ${num(n)} of 100 CU-hours this month` },
  FirestoreQuotaHigh: { key: "FirestoreQuotaHigh", severity: "warning", threshold: 80, bounds: [10, 100], source: "test", needs: "databases", sampled: false, condition: (n) => `Daily reads > ${num(n)}% of 50k` },
  AutoPauseRisk: { key: "AutoPauseRisk", severity: "info", threshold: 4, bounds: [1, 6], source: "api", needs: "databases", sampled: false, condition: (n) => `Supabase project without API traffic for ${num(n)}+ days` },
  DnsProxiedToVercel: { key: "DnsProxiedToVercel", severity: "info", threshold: null, bounds: null, source: "api", needs: "dns", sampled: false, condition: () => "Cloudflare record proxied in front of Vercel" },
  // Stage 12: Supabase compute from the Metrics API (lib/databases/compute-metrics.ts computeLimits): the one threshold
  // T sets CPU (sustained 15 min), disk and connections; RAM is T + 10.
  ComputeHigh: { key: "ComputeHigh", severity: "warning", threshold: 80, bounds: [50, 95], source: "api", needs: "databases", sampled: false, condition: (n) => `Supabase CPU > ${num(n)}% for 15 min, RAM > ${num(Math.min(99, (n ?? 80) + 10))}%, disk > ${num(n)}% or connections > ${num(n)}% of max` },
  // Stage 8: Turso (rows read/written a month, org), Upstash Redis (commands and bandwidth a month) and Cloudflare D1
  // (rows read/written a day, account) past T% of a free-plan usage quota. Their storage uses StorageAlmostFull.
  DbQuotaHigh: { key: "DbQuotaHigh", severity: "warning", threshold: 80, bounds: [10, 100], source: "api", needs: "databases", sampled: false, condition: (n) => `Turso, Upstash or D1 usage > ${num(n)}% of a free-plan quota` },
  CredentialExpiring: { key: "CredentialExpiring", severity: "warning", threshold: 14, bounds: [1, 60], source: "api", needs: null, sampled: false, condition: (n) => `Account credential expires in < ${num(n)} days` },
  // Stage 9 slice 5: the linked repository's lockfile has a high (warning) or critical / remote-code-execution advisory
  // (critical) in a non-dev package. One alert per app. A critical one raises the default warning to critical.
  VulnerableDependency: { key: "VulnerableDependency", severity: "warning", threshold: null, bounds: null, source: "api", needs: null, sampled: false, condition: () => "A dependency has a critical or high advisory, or a moderate one on a direct dependency (OSV.dev)" },
  // Watchbell 1.2 (owner 23 Oct): the Security card's Next.js check (the version the live site runs, against OSV.dev) says
  // "vulnerable". One alert per app. A critical advisory raises the default warning to critical.
  FrameworkVulnerable: { key: "FrameworkVulnerable", severity: "warning", threshold: null, bounds: null, source: "own", needs: null, sampled: false, condition: () => "The app's Next.js version has a known advisory (OSV.dev)" },
  // Watchbell 1.2.1: an HTTP monitor still checks a domain its app no longer has (the app moved to a new domain). Fires
  // instead of MonitorDown for that monitor; the fix is Update monitor, never a redeploy.
  MonitorDomainMoved: { key: "MonitorDomainMoved", severity: "warning", threshold: null, bounds: null, source: "own", needs: null, sampled: false, condition: () => "The monitor's domain is no longer one of the app's domains" },
};

export const RULE_KEYS = Object.keys(RULES) as RuleKey[];
export const isRuleKey = (v: unknown): v is RuleKey => typeof v === "string" && v in RULES;

export type RuleConfig = { key: RuleKey; severity: Severity; threshold: number | null; enabled: boolean; channels: ChannelKind[] };

const SEVERITIES: Severity[] = ["critical", "warning", "info"];
const CHANNELS: ChannelKind[] = ["telegram", "discord", "webhook", "smtp", "email_digest"];

// Rules → Edit. Input may come from a crafted request, so nothing is assumed.
export function parseRuleForm(
  key: RuleKey, f: { severity?: unknown; threshold?: unknown; channels?: unknown; enabled?: unknown },
): { ok: true; value: Omit<RuleConfig, "key"> } | { ok: false; fieldErrors: Record<string, string> } {
  const def = RULES[key];
  const errors: Record<string, string> = {};
  const severity = SEVERITIES.find((s) => s === f.severity);
  if (!severity) errors.severity = "Pick a severity.";
  let threshold: number | null = null;
  if (def.bounds) {
    const raw = String(f.threshold ?? "").replace(/,/g, "").trim();
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < def.bounds[0] || n > def.bounds[1]) errors.threshold = `Enter a whole number from ${num(def.bounds[0])} to ${num(def.bounds[1])}.`;
    else threshold = n;
  }
  const list = Array.isArray(f.channels) ? f.channels : [];
  if (!list.every((c) => CHANNELS.includes(c as ChannelKind))) errors.channels = "Pick from Telegram, Discord and the daily digest.";
  if (Object.keys(errors).length || !severity) return { ok: false, fieldErrors: errors };
  return { ok: true, value: { severity, threshold, channels: [...new Set(list as ChannelKind[])], enabled: f.enabled === true } };
}

// 1.2.3 (UI audit K9): the name people read first. The key stays the rule's identity (API, Telegram's last line, the
// docs) and shows small after the name. Unknown keys (an old row) fall back to the key itself.
export const RULE_NAMES: Record<RuleKey, string> = {
  MonitorDown: "Site down",
  CollectorStale: "Checks stopped",
  HighLatency: "Slow responses",
  DeploymentFailed: "Deploy failed",
  DatabasePaused: "Database paused",
  CertExpiringSoon: "Certificate expiring",
  DomainExpiringSoon: "Domain expiring",
  StorageAlmostFull: "Database almost full",
  NeonComputeHigh: "Neon hours running out",
  FirestoreQuotaHigh: "Firestore reads running out",
  AutoPauseRisk: "Supabase may pause",
  DnsProxiedToVercel: "Cloudflare proxy in front of Vercel",
  ComputeHigh: "Supabase under load",
  DbQuotaHigh: "Free quota running out",
  CredentialExpiring: "Token expiring",
  VulnerableDependency: "Vulnerable package",
  FrameworkVulnerable: "Next.js needs a security update",
  MonitorDomainMoved: "App moved to a new domain",
};
export const ruleName = (key: string): string => (isRuleKey(key) ? RULE_NAMES[key] : key);
