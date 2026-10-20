import "server-only";
import { type DecideOutcome, decideProposal, executeProposal } from "./proposals-db";
import { HISTORY_TIMEOUT_MS, type HistoryEvent, notifyHistory } from "./proposals-notify";
import type { Proposal } from "./proposals-types";

// The ONE decide path (Stage 9 slices 1 and 7): the office route (POST /api/office/proposals/{id}/decide) and the
// Telegram buttons both call this. decideProposal is the compare-and-set on a pending, unexpired proposal; an approval
// then runs at once through executeProposal with this owner as the actor (approved → running → done | failed), which
// writes the action's own audit row. `onApproved` runs between the two (the Telegram message shows "jalan").
export type DecideMember = { id: string; userId: string };
// `history` is the Discord action history (owner 19 Oct): approved / rejected, then ran / failed. It lives here, in the one
// path, so the Telegram buttons and the console both produce it. It never throws; it is sent by flushHistory, last.
export type DecideAndRunDeps = {
  decide: typeof decideProposal; execute: (id: string, who: DecideMember, now: Date) => Promise<Proposal | null>;
  history?: (event: HistoryEvent, p: Proposal) => Promise<void>;
};
// `flushHistory` sends the collected history lines (in order). Nothing is sent inside decideAndRun: the caller answers the owner,
// shows the result and audits first, then calls this LAST (the route and the page action through after()). Never throws;
// gives up after HISTORY_TIMEOUT_MS whatever Discord does.
export type DecideResult = DecideOutcome & { flushHistory?: () => Promise<void> };
const DEPS: DecideAndRunDeps = { decide: decideProposal, execute: (id, who, now) => executeProposal(id, who, now), history: (event, p) => notifyHistory(event, p) };

export async function decideAndRun(
  id: string, decision: "approve" | "reject", member: DecideMember, now: Date,
  opts: { onApproved?: (p: Proposal) => Promise<void> } = {}, deps: DecideAndRunDeps = DEPS,
): Promise<DecideResult> {
  const d = await deps.decide(id, decision, member.id, now);
  if (d.status !== "ok") return d.status === "missing" ? { status: "missing" } : { status: "conflict", proposal: d.proposal };
  const queue: Array<[HistoryEvent, Proposal]> = [];
  const flushHistory = async (): Promise<void> => {
    const send = deps.history;
    if (!send || !queue.length) return;
    const lines = queue.splice(0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => { timer = setTimeout(resolve, HISTORY_TIMEOUT_MS); });
    const all = (async () => { for (const [event, p] of lines) await send(event, p).catch(() => undefined); })();
    await Promise.race([all, budget]).finally(() => clearTimeout(timer));
  };
  if (decision === "reject") {
    queue.push(["rejected", d.proposal]);
    return { status: "ok", proposal: d.proposal, flushHistory };
  }
  queue.push(["approved", d.proposal]);
  if (opts.onApproved) await opts.onApproved(d.proposal).catch(() => undefined);
  const ran = await deps.execute(id, { id: member.id, userId: member.userId }, new Date());
  if (ran && (ran.status === "done" || ran.status === "failed")) queue.push([ran.status, ran]);
  return { status: "ok", proposal: ran ?? d.proposal, flushHistory };
}
