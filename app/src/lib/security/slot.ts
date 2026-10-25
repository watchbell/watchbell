// Watchbell 1.2.1, fix round 1 (review important 1): the collector's 6-hourly `security` run can't check every app and
// scan every repository in one minute run's budget, so its slot continues in the next minute runs until both parts went
// through their whole list (oldest first). ops.settings "security.slot" keeps what this slot already tried, so nothing is
// done twice in a slot; the slot is saved as done (collector.lastRun) only once complete. Pure.
// Fix round 2 (re-review important 1): a Next.js check cut by the run's time limit isn't done; it is tried again in a
// later run of the slot, at most CUT_TRIES times in all, then left to the daily job (it has more time).

export const SLOT_SETTING = "security.slot";
// A slot never takes more than this many minute runs (a list that keeps growing, a part that keeps failing).
export const SLOT_MAX_RUNS = 20;
const LIST_MAX = 1_000;
export const CUT_TRIES = 2;

// next: the apps whose Next.js check finished (or failed) in this slot; cut: how many of an app's checks this slot were
// cut by the time limit; repos: the repositories tried; nextDone / depsDone: that part went through its whole list.
export type SlotProgress = {
  slot: string; runs: number; next: string[]; repos: string[]; cut: Record<string, number>; nextDone: boolean; depsDone: boolean;
};

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 100).slice(0, LIST_MAX) : []);

export function parseSlot(raw: unknown, slot: string): SlotProgress {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (src.slot !== slot) return { slot, runs: 0, next: [], repos: [], cut: {}, nextDone: false, depsDone: false };
  const runs = typeof src.runs === "number" && Number.isInteger(src.runs) && src.runs >= 0 ? src.runs : 0;
  const cut: Record<string, number> = {};
  if (src.cut && typeof src.cut === "object" && !Array.isArray(src.cut)) {
    for (const [app, n] of Object.entries(src.cut as Record<string, unknown>).slice(0, LIST_MAX)) {
      if (app.length <= 100 && typeof n === "number" && Number.isInteger(n) && n > 0) cut[app] = Math.min(n, CUT_TRIES);
    }
  }
  return { slot, runs, next: ids(src.next), repos: ids(src.repos), cut, nextDone: src.nextDone === true, depsDone: src.depsDone === true };
}

export const addIds = (list: readonly string[], more: readonly string[]): string[] => [...new Set([...list, ...more])].slice(0, LIST_MAX);

// hosting / devops: the part runs (its section is on); a paused part doesn't hold the slot open.
export function slotComplete(p: SlotProgress, hosting: boolean, devops: boolean): boolean {
  return ((p.nextDone || !hosting) && (p.depsDone || !devops)) || p.runs >= SLOT_MAX_RUNS;
}
