import type { State } from "@/lib/status";

// Neon free plan, checked 12 Oct 2026, re-checked 16 Oct 2026 (neon.com/docs/introduction/plans): 100 CU-hours per project a month, 1 GB storage
// per project, 5 GB egress per project a month, 10 branches, scale to zero after 5 min (fixed). When the CU-hours or
// transfer run out, the compute is suspended until the next period.
export const NEON_FREE = { cuHours: 100, storageBytes: 1024 ** 3, transferBytes: 5 * 1024 ** 3, branches: 10, scaleToZeroMin: 5 } as const;

type Ep = { state: string; pendingState: string | null; disabled: boolean };

export function endpointState(e: Ep): { state: State; label: string } {
  if (e.disabled) return { state: "err", label: "Suspended" };
  if (e.state === "init" || (e.pendingState && e.pendingState !== e.state)) return { state: "build", label: "Starting" };
  if (e.state === "active") return { state: "ok", label: "Active" };
  if (e.state === "idle") return { state: "idle", label: "Idle" };
  return { state: "unknown", label: "Unknown" };
}

export function neonProjectState(i: { endpoints: Ep[]; computeSeconds: number | null }): { state: State; label: string } {
  if ((i.computeSeconds ?? 0) >= NEON_FREE.cuHours * 3600) return { state: "err", label: "CU-hours used up" };
  if (!i.endpoints.length) return { state: "unknown", label: "No compute" };
  const states = i.endpoints.map(endpointState);
  if (states.some((s) => s.state === "err")) return { state: "err", label: "Compute suspended" };
  if (states.some((s) => s.state === "ok")) return { state: "ok", label: "Active" };
  if (states.some((s) => s.state === "build")) return { state: "build", label: "Starting" };
  if (states.every((s) => s.state === "idle")) return { state: "idle", label: "Idle" };
  return { state: "unknown", label: "Unknown" };
}

export const cuHours = (seconds: number) => Math.round(seconds / 360) / 10;
export const autoscalingText = (min: number, max: number) => (min === max ? `${min} CU` : `${min}–${max} CU`);
