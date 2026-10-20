import type { Severity } from "@/db/schema";
import type { State } from "@/lib/status";
import { clock } from "@/lib/time";

export const sevLabel = (s: Severity) => s[0].toUpperCase() + s.slice(1);
export const SEV_OPTIONS: [string, string][] = [["critical", "Critical"], ["warning", "Warning"], ["info", "Info"]];

export function notifiedText(
  a: { pending: string | null; notifiedOpen: boolean; lastNotifiedAt: Date | null; causedBy: string | null; silencedUntil: Date | null; silencedUntilResolved: boolean },
  now: Date,
): { state: State; text: string } {
  if (a.silencedUntilResolved) return { state: "off", text: "Silenced until resolved" };
  if (a.silencedUntil && a.silencedUntil.getTime() > now.getTime()) return { state: "off", text: `Silenced until ${clock(a.silencedUntil)}` };
  if (a.pending === "open" || a.pending === "repeat") return { state: "build", text: "Sending…" };
  if (a.causedBy && !a.notifiedOpen) return { state: "off", text: "Muted" };
  if (a.lastNotifiedAt) return { state: "ok", text: `Sent ${clock(a.lastNotifiedAt)}` };
  return { state: "off", text: "Digest only" };
}

export function ruleState(r: { enabled: boolean; firing: number; hasData: boolean }): { state: State; text: string } {
  if (!r.enabled) return { state: "off", text: "Disabled" };
  if (r.firing) return { state: "err", text: `Firing · ${r.firing}` };
  return r.hasData ? { state: "off", text: "Inactive" } : { state: "unknown", text: "No data yet" };
}

export function tookText(start: Date, end: Date): string {
  const min = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export function silenceUntil(choice: "1h" | "resolved", now: Date): { silencedUntil: Date | null; silencedUntilResolved: boolean } {
  return choice === "1h" ? { silencedUntil: new Date(now.getTime() + 3_600_000), silencedUntilResolved: false } : { silencedUntil: null, silencedUntilResolved: true };
}
