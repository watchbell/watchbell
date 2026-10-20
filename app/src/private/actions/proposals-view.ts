import type { State } from "@/lib/status";
import type { Proposal, ProposalStatus } from "./proposals-types";

// The Auto-actions page's two lists (pure): what waits for the owner and what already happened, each newest first,
// plus the proposal a ?proposal=<id> link points at (null when it isn't in the list).
export function proposalsView(list: Proposal[], focusId: string | null): { pending: Proposal[]; history: Proposal[]; focus: Proposal | null } {
  const seen = new Set<string>();
  const unique = list.filter((p) => !seen.has(p.id) && seen.add(p.id));
  const newest = [...unique].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    pending: newest.filter((p) => p.status === "pending"),
    history: newest.filter((p) => p.status !== "pending"),
    focus: (focusId && unique.find((p) => p.id === focusId)) || null,
  };
}

const STATE: Record<ProposalStatus, State> = {
  pending: "info", approved: "build", running: "build", done: "ok", failed: "fail", rejected: "off", expired: "idle",
};

export const statusState = (s: ProposalStatus): State => STATE[s];
