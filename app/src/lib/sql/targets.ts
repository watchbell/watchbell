import { type NeonData, neonData, readData } from "@/lib/databases/snapshot-data";

// Stage 9 slice 2: whether a run (or the save test) would wake a Neon compute, from the latest snapshot only. The
// console never wakes one on its own: an idle or unknown compute needs the owner's explicit yes.

export const WAKE_TEXT = "Running this will wake the Neon compute (uses CU-hours). Run anyway?";

export type WakeState = "idle" | "active" | "unknown";

export function neonWakeState(raw: unknown, endpointId: string | null): WakeState {
  const d: NeonData = readData(neonData, raw);
  const eps = d.endpoints ?? [];
  const ep = endpointId ? eps.find((e) => e.id === endpointId) : undefined;
  const pick = ep ? [ep] : endpointId ? [] : eps;
  if (!pick.length) return "unknown";
  if (pick.some((e) => e.state === "active" && !e.disabled && (!e.pendingState || e.pendingState === "active"))) return "active";
  if (pick.every((e) => e.state === "idle" && (!e.pendingState || e.pendingState === "idle"))) return "idle";
  return "unknown";
}

// True when the owner must confirm first. A connection to an endpoint the snapshot doesn't list counts as unknown.
export function needsWakeConfirm(provider: string, raw: unknown, endpointId: string | null): boolean {
  return provider === "neon" && neonWakeState(raw, endpointId) !== "active";
}

// The endpoint in a Neon string must belong to this project (when the snapshot lists the project's endpoints).
export function endpointBelongs(raw: unknown, endpointId: string | null): boolean {
  const eps = readData(neonData, raw).endpoints ?? [];
  return !endpointId || !eps.length || eps.some((e) => e.id === endpointId);
}
