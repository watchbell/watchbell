import type { Ping } from "@/lib/providers/firebase";
import type { Result } from "@/lib/providers/http";
import type { State } from "@/lib/status";

// Firestore on Spark (re-checked 16 Oct 2026, firebase.google.com/docs/firestore/quotas): 50k reads, 20k writes, 20k
// deletes a day, reset at midnight Pacific time; 1 GiB stored.
export const FIRESTORE_FREE = { reads: 50_000, writes: 20_000, deletes: 20_000 } as const;

// Review T4c (Important 1): Watchbell reads reads/writes/deletes from Cloud Monitoring (Blaze only) but never the
// stored size, on any plan (firestoreOps has no size). The Firebase banner and the Usage page say so with these words.
export const FIRESTORE_SIZE_NOTE = "The stored data size (1 GiB free) isn't read on any plan: the row's Open usage page shows it in the Firebase console.";
export const FIRESTORE_USAGE_STORAGE = "Storage (1 GiB): not read; the Firebase console's usage page shows it.";

export function firestoreState(p: Result<Ping>): { state: State; label: string } {
  if (p.ok) {
    if (p.data.noDatabase) return { state: "off", label: "No Firestore database" };
    return { state: "ok", label: `Reachable · ${p.data.latencyMs} ms` };
  }
  return firestoreFailure(p);
}

// One rule for what a failed Firestore read means, used by the collector (the state) and the page (the words), so a
// missing role is named instead of shown as "Unknown". Google answers a missing role with 403 PERMISSION_DENIED, and a
// project where the API is off with 403 SERVICE_DISABLED; a daily quota that ran out is 429 RESOURCE_EXHAUSTED.
export function firestoreFailure(f: { kind?: string | null; reason?: string | null }): { state: State; label: string } {
  if (f.reason === "RESOURCE_EXHAUSTED") return { state: "err", label: "Daily quota used up" };
  if (f.reason === "SERVICE_DISABLED") return { state: "err", label: "Firestore API is off in this project" };
  if (f.kind === "scope" || f.reason === "PERMISSION_DENIED" || f.reason === "scope") return { state: "err", label: "No access: needs datastore.viewer" };
  return { state: "unknown", label: "Unknown" };
}

// "Today" for Firestore's quota: since midnight in Los Angeles. On the two DST switch days the start can be an hour off.
export function quotaDayStart(now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(now);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const sinceMidnight = (n("hour") * 3600 + n("minute") * 60 + n("second")) * 1000 + now.getUTCMilliseconds();
  return new Date(now.getTime() - sinceMidnight);
}
