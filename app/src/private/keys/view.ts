import type { State } from "@/lib/status";
import { ago, calendarDate, clock, dayMonth } from "@/lib/time";
import { type KeyStatus, keyStatus } from "./key";

// What the keys table shows per row. Pure, so the wording is tested without rendering.
export const KEY_STATE: Record<KeyStatus, { state: State; label: string }> = {
  active: { state: "ok", label: "Active" },
  "never-used": { state: "idle", label: "Never used" },
  expired: { state: "warn", label: "Expired" },
  revoked: { state: "off", label: "Revoked" },
};

// The filter's options, in the mockup's order (+ Expired, which the mockup has no sample for).
export const KEY_FILTER_STATES: [string, string][] = [["ok", "Active"], ["idle", "Never used"], ["warn", "Expired"], ["off", "Revoked"]];

type Times = { createdAt: Date; expiresAt: Date | null; revokedAt: Date | null; lastUsedAt: Date | null };

export function keyView(k: Times, now: Date): { status: KeyStatus; state: State; label: string; created: string; expires: string; lastUsed: string } {
  const status = keyStatus(k, now);
  const { day, month, year } = k.expiresAt ? calendarDate(k.expiresAt) : { day: 0, month: "", year: 0 };
  return {
    status,
    ...KEY_STATE[status],
    created: `${dayMonth(k.createdAt)} ${clock(k.createdAt)}`,
    expires: k.revokedAt ? `Revoked ${dayMonth(k.revokedAt)}` : k.expiresAt ? `${day} ${month} ${year}` : "Never",
    lastUsed: k.lastUsedAt ? ago(k.lastUsedAt, now) : "Never used",
  };
}

// The agents table counters: 1,234 → "1.2k", 61,200 → "61.2k", 1,250,000 → "1.3M".
export function compactCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const k = Math.round(n / 100) / 10;
  return k < 1000 ? `${k}k` : `${Math.round(n / 100_000) / 10}M`;
}
