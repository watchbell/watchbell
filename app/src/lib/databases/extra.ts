import type { State } from "@/lib/status";
import type { D1Data, TursoData, UpstashData } from "./snapshot-data";

// Stage 8: the free plans of Turso, Upstash Redis and Cloudflare D1, as read from the official pages on 16 Oct 2026.
// Sizes are binary (MB = 1024², GB = 1024³), like the Supabase and Neon limits, so a page's "x MB of 500 MB" and its
// percentage agree.
//   Turso Free (turso.tech/pricing): 100 databases, 5 GB storage, 500M rows read and 10M rows written a month, per
//     organization; the month is the calendar month (the usage API's default window).
//   Upstash Redis Free (upstash.com/pricing/redis): 500K commands a month, 10 GB bandwidth a month and 256 MB data
//     per database. The page's card says 250 MB and its table 256 MB: the console uses the lower 250 MB.
//   Cloudflare D1 Free (developers.cloudflare.com/d1/platform/limits and /pricing): 10 databases, 500 MB per database,
//     5 GB per account, 5M rows read and 100K rows written a day per account, reset at 00:00 UTC.
const MB = 1024 ** 2;
const GB = 1024 ** 3;
export const TURSO_FREE = { databases: 100, storageBytes: 5 * GB, rowsRead: 500_000_000, rowsWritten: 10_000_000 } as const;
export const UPSTASH_FREE = { storageBytes: 250 * MB, monthlyCommands: 500_000, monthlyBandwidthBytes: 10 * GB } as const;
export const D1_FREE = { databases: 10, dbBytes: 500 * MB, accountBytes: 5 * GB, rowsReadPerDay: 5_000_000, rowsWrittenPerDay: 100_000 } as const;

export type Share = { label: string; pct: number | null; text: string; kind: "storage" | "quota" };

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (used: number, limit: number) => round1((used / limit) * 100);
const short = (n: number) => (n >= 1_000_000 ? `${round1(n / 1_000_000)}M` : n >= 1000 ? `${round1(n / 1000)}k` : String(n));

// ---- states (the hourly task sets them; the pages show them) ----

export function tursoState(d: { blockReads: boolean; blockWrites: boolean; orgBlockedReads?: boolean; orgBlockedWrites?: boolean }): { state: State; label: string } {
  if (d.blockReads || d.orgBlockedReads) return { state: "err", label: "Reads blocked" };
  if (d.blockWrites || d.orgBlockedWrites) return { state: "err", label: "Writes blocked" };
  return { state: "ok", label: "Available" };
}

export function upstashState(status: string | null): { state: State; label: string } {
  const s = (status ?? "").toLowerCase();
  if (s === "active") return { state: "ok", label: "Active" };
  if (s.includes("suspend") || s.includes("block") || s.includes("disabled")) return { state: "err", label: "Suspended" };
  if (s.includes("delet")) return { state: "off", label: "Deleting" };
  return { state: "unknown", label: status ? `State: ${status}` : "Unknown" };
}

// D1 has no status; a listed database is available. The account hitting a daily row quota makes queries fail until
// 00:00 UTC, which is the one thing worth a red state.
export function d1State(i: { accountRowsRead: number | null; accountRowsWritten: number | null }): { state: State; label: string } {
  if ((i.accountRowsRead ?? 0) >= D1_FREE.rowsReadPerDay) return { state: "err", label: "Daily rows-read limit reached" };
  if ((i.accountRowsWritten ?? 0) >= D1_FREE.rowsWrittenPerDay) return { state: "err", label: "Daily rows-written limit reached" };
  return { state: "ok", label: "Available" };
}

// ---- shares of the free plan (Free databases overview, the pages and the alert facts) ----

// The month the usage belongs to: a reading from an earlier calendar month (UTC) says nothing about this one.
const sameMonth = (at: string | null | undefined, now: Date) => !!at && at.slice(0, 7) === now.toISOString().slice(0, 7);

export function tursoShares(d: TursoData, now: Date): Share[] {
  if (!sameMonth(d.usageAt, now)) return [];
  return [
    ...(d.orgRowsRead != null ? [{ label: "Rows read", pct: pct(d.orgRowsRead, TURSO_FREE.rowsRead), text: "of 500M this month (org)", kind: "quota" as const }] : []),
    ...(d.orgRowsWritten != null ? [{ label: "Rows written", pct: pct(d.orgRowsWritten, TURSO_FREE.rowsWritten), text: "of 10M this month (org)", kind: "quota" as const }] : []),
    ...(d.orgStorageBytes != null ? [{ label: "Storage", pct: pct(d.orgStorageBytes, TURSO_FREE.storageBytes), text: "of 5 GB (org)", kind: "storage" as const }] : []),
  ];
}

export function upstashShares(d: UpstashData, now: Date): Share[] {
  const fresh = sameMonth(d.statsAt, now);
  return [
    ...(fresh && d.monthlyRequests != null ? [{ label: "Commands", pct: pct(d.monthlyRequests, UPSTASH_FREE.monthlyCommands), text: "of 500k this month", kind: "quota" as const }] : []),
    ...(fresh && d.monthlyBandwidthBytes != null ? [{ label: "Bandwidth", pct: pct(d.monthlyBandwidthBytes, UPSTASH_FREE.monthlyBandwidthBytes), text: "of 10 GB this month", kind: "quota" as const }] : []),
    ...(d.storageBytes != null ? [{ label: "Data size", pct: pct(d.storageBytes, UPSTASH_FREE.storageBytes), text: "of 250 MB", kind: "storage" as const }] : []),
  ];
}

export function d1Shares(d: D1Data, now: Date): Share[] {
  const today = d.usageDay === now.toISOString().slice(0, 10);
  return [
    ...(today && d.accountRowsRead != null ? [{ label: "Rows read today", pct: pct(d.accountRowsRead, D1_FREE.rowsReadPerDay), text: "of 5M (account)", kind: "quota" as const }] : []),
    ...(today && d.accountRowsWritten != null ? [{ label: "Rows written today", pct: pct(d.accountRowsWritten, D1_FREE.rowsWrittenPerDay), text: "of 100k (account)", kind: "quota" as const }] : []),
    ...(d.sizeBytes != null ? [{ label: "Size", pct: pct(d.sizeBytes, D1_FREE.dbBytes), text: "of 500 MB", kind: "storage" as const }] : []),
  ];
}

// The highest quota share (not storage): what DbQuotaHigh compares with its threshold.
export function topQuota(shares: Share[]): Share | null {
  return shares.filter((s) => s.kind === "quota" && s.pct !== null).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0] ?? null;
}

export const countText = short;
