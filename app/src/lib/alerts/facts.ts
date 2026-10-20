// What the rules look at, read once per evaluation (lib/data/alert-facts-db.ts). `dbs`, `domains` and `dns` are null
// until stages 3 and 4 deliver them: the rules that need them are then not evaluated at all (S1).
import type { ComputeFact } from "@/lib/databases/compute-metrics";
import type { State } from "@/lib/status";

export type MonitorFact = {
  id: string; appId: string; appName: string; url: string; kind: "http" | "heartbeat"; state: State; failStreak: number;
  lastStatus: number | null; lastError?: string | null; lastCheckedAt: Date | null; p95Last10: number | null; checksLast10: number;
};
export type AppFact = { id: string; name: string; latestProduction: { state: string; sha: string | null; createdAt: Date } | null };
export type AccountFact = { id: string; provider: string; label: string; expiresAt: Date | null; status: "ok" | "error"; lastError: string | null };
export type DbFact = {
  id: string; name: string; provider: "supabase" | "neon" | "firestore" | "turso" | "upstash" | "d1"; state: State;
  sizeBytes: number | null; sizeLimitBytes: number | null; lastApiAt: Date | null;
  cuHours: number | null; cuLimit: number | null; readsToday: number | null; readsLimit: number | null; quotaExhausted: boolean | null;
  // Stage 8 (Turso, Upstash, D1): the highest usage quota share in % and what it is ("Rows read of 500M this month (org)").
  quotaPct?: number | null; quotaLabel?: string | null;
};
export type DomainFact = { id: string; name: string; tlsNotAfter: Date | null; expiresAt: Date | null };
// `id` is the alert subject (`zoneId:recordId`); `resourceId` is the domain row the record serves, else its zone.
export type DnsFact = { id: string; resourceId: string; name: string; proxied: boolean; pointsToVercel: boolean };
export type LinkFact = { appId: string; dbId: string };
// Stage 9 slice 5: a scanned app's open dependency advisories (lib/data/deps-db.ts loadAppDeps). error: the last scan
// failed, so its rows may be stale (the rule then holds: unknown).
export type DepFact = {
  appId: string; error: string | null;
  vulns: { package: string; installedVersion: string; fixedVersion: string | null; severity: "critical" | "high" | "moderate" | "low" | "unknown"; summary: string; dev: boolean }[];
};

export type Facts = {
  now: Date; lastMinuteRunAt: Date | null;
  // The last finished run of any scheduler (cron-job.org, QStash fallback, manual). Absent: use lastMinuteRunAt.
  lastAnyRunAt?: Date | null; monitors: MonitorFact[]; apps: AppFact[]; accounts: AccountFact[];
  dbs: DbFact[] | null; domains: DomainFact[] | null; dns: DnsFact[] | null; links: LinkFact[];
  // Stage 12: Supabase projects with a metrics key (null/absent: none has one, ComputeHigh is not evaluated).
  compute?: ComputeFact[] | null;
  // Absent or null: no app has been scanned yet, so VulnerableDependency isn't evaluated.
  deps?: DepFact[] | null;
};
