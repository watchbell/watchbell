import type { NewEvent } from "@/lib/collector/rules";
import type { DbKind } from "@/lib/links";
import type { FailureKind } from "@/lib/providers/http";
import { type State, STATES } from "@/lib/status";

// D6: while a provider is unreachable the snapshot reads "unknown" and keeps the last good state in data.
export function goodState(prev: { state: State; data: Record<string, unknown> } | null): State | null {
  if (!prev) return null;
  if (prev.state !== "unknown") return prev.state;
  const g = prev.data?.lastGoodState;
  return typeof g === "string" && (STATES as readonly string[]).includes(g) ? (g as State) : null;
}

const EXTRA_WHO: Partial<Record<DbKind, string>> = { turso_database: "Turso database", upstash_redis: "Upstash Redis", d1_database: "D1 database" };

// D5: database events, only on a real change between known states. First sight and unknown are never news.
export function databaseEvent(i: { kind: DbKind; resourceId: string; prev: State | null; next: State; label: string; at: Date }): NewEvent | null {
  const { prev, next } = i;
  if (prev === null || prev === "unknown" || next === "unknown" || prev === next) return null;
  const base = { resourceId: i.resourceId, type: "database" as const, at: i.at };
  if (i.kind === "supabase_project") {
    if (next === "paused") return { ...base, reason: "DatabasePaused", kind: "paused", message: "Supabase project paused", detail: "Status changed to INACTIVE" };
    if (next === "ok") return { ...base, reason: "DatabaseRestored", kind: "ok", message: "Supabase project active again", detail: "Status changed to ACTIVE_HEALTHY" };
    if (next === "warn") return { ...base, reason: "DatabaseUnhealthy", kind: "warn", message: "Supabase project unhealthy", detail: i.label };
    if (next === "err") return { ...base, reason: "DatabaseFailed", kind: "err", message: `Supabase project: ${i.label.toLowerCase()}`, detail: i.label };
    return null;
  }
  if (i.kind === "neon_project") {
    // Scale to zero flips idle ↔ active many times a day; only a suspended compute and its return are news.
    if (next === "err") return { ...base, reason: "NeonSuspended", kind: "err", message: "Neon compute suspended", detail: i.label };
    if (prev === "err" && (next === "ok" || next === "idle")) return { ...base, reason: "NeonAvailable", kind: "ok", message: "Neon compute available again", detail: i.label };
    return null;
  }
  // Stage 8: Turso, Upstash Redis and Cloudflare D1 have no pause; a block, a suspension or a used-up quota is news,
  // and so is its end.
  const extra = EXTRA_WHO[i.kind];
  if (extra) {
    if (next === "err") return { ...base, reason: "DatabaseFailed", kind: "err", message: `${extra}: ${i.label.toLowerCase()}`, detail: i.label };
    if (next === "off") return { ...base, reason: "DatabaseMissing", kind: "off", message: `${extra} missing`, detail: i.label };
    if (next === "ok" && (prev === "err" || prev === "off")) return { ...base, reason: "DatabaseRestored", kind: "ok", message: `${extra} available again`, detail: i.label };
    return null;
  }
  if (next === "err") {
    const quota = i.label === "Daily quota used up";
    return { ...base, reason: quota ? "FirestoreQuotaUsedUp" : "FirestoreUnreachable", kind: "err", message: quota ? "Firestore daily quota used up" : "Firestore not reachable", detail: i.label };
  }
  if (next === "off") return { ...base, reason: "FirestoreMissing", kind: "off", message: "Firestore database missing", detail: i.label };
  if (next === "ok" && (prev === "err" || prev === "off")) return { ...base, reason: "FirestoreReachable", kind: "ok", message: "Firestore reachable again", detail: i.label };
  return null;
}

// What a failed provider call does. A rejected credential flips the account (statusAfterTest); a scope gap on one
// optional call only empties that column; anything else is "unknown, try again next run".
export function classifyFailure(f: { kind: FailureKind }, wholeAccount: boolean): "auth" | "column" | "unknown" {
  if (f.kind === "auth") return "auth";
  if (f.kind === "scope") return wholeAccount ? "auth" : "column";
  if (f.kind === "missing") return wholeAccount ? "unknown" : "column";
  return "unknown";
}
