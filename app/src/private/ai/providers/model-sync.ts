import type { NotifyLang } from "@/lib/notify/lang";
import type { ModelTest, StoredModel } from "./routing";

// Model sync (owner 16 Oct): the owner's router (a custom OpenAI-compatible connection, 9Router) is the source of truth
// for which models exist. Pure: the diff between the stored list and the router's /models, which models a run tests,
// how test results change the list, the throttle and the Telegram lines. The I/O is in model-sync-db.ts.
//   - an id the router no longer lists: kept, off, `removed` (history stays; Models shows "removed in 9Router");
//   - an id that comes back: un-removed and tested again before it is on;
//   - a new id: off and `pending` until one tiny completion passes (then on: every kind, owner "Auto-enable all");
//     a failure leaves it off with lastTest's short error;
//   - a model whose last test failed is re-tested, at most MAX_RETESTS per run, oldest test first; a pass turns it on;
//   - `manualOff` (the owner switched it off on Models) and manual ids (added by hand, never in /models) are never
//     switched or tested by the sync.

export const SYNC_SETTING = "ai.modelSync"; // ops.settings: SyncState
export const SYNC_EVERY_MS = 6 * 3_600_000;
export const PENDING_RETRY_MS = 5 * 60_000; // untested new models: the next run comes this soon
export const CHECK_EVERY_MS = 5 * 60_000; // a warm instance reads the sync state at most this often
export const MAX_NEW_TESTS = 8;
export const MAX_RETESTS = 3;
export const MIN_RUN_MS = 20_000; // the minute step doesn't start a run with less time than this before its deadline
export const NEW_BADGE_MS = 7 * 86_400_000;

export type ListedModel = Omit<StoredModel, "enabled">;
export type SyncPlan = {
  models: StoredModel[]; added: string[]; removed: string[]; returned: string[]; toTest: string[]; toRetest: string[];
};

// Drops keys whose value is undefined (jsonb would drop them anyway; keeps comparisons and stored rows tidy).
function tidy(m: StoredModel): StoredModel {
  const out = { ...m } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as StoredModel;
}

const testedAt = (m: StoredModel) => (m.lastTest ? Date.parse(m.lastTest.at) || 0 : 0);

export function planModelSync(previous: StoredModel[], listed: ListedModel[], now: Date, limits: { maxNew?: number; maxRetest?: number } = {}): SyncPlan {
  const at = now.toISOString();
  const manual = previous.filter((p) => p.manual === true);
  const manualIds = new Set(manual.map((m) => m.id));
  const prevById = new Map(previous.filter((p) => p.manual !== true).map((p) => [p.id, p]));
  const listedIds = new Set<string>();
  const added: string[] = [], removed: string[] = [], returned: string[] = [];
  const out: StoredModel[] = [];
  for (const m of listed) {
    if (manualIds.has(m.id) || listedIds.has(m.id)) continue;
    listedIds.add(m.id);
    const prev = prevById.get(m.id);
    if (!prev) {
      out.push(tidy({ ...m, enabled: false, pending: true, addedAt: at }));
      added.push(m.id);
    } else if (prev.removed) {
      out.push(tidy({ ...prev, ...m, removed: undefined, removedAt: undefined, enabled: false, pending: prev.manualOff ? undefined : true }));
      returned.push(m.id);
    } else {
      out.push(tidy({ ...prev, ...m, enabled: prev.enabled }));
    }
  }
  for (const p of previous) {
    if (p.manual === true || listedIds.has(p.id)) continue;
    if (p.removed) { out.push(p); continue; }
    out.push(tidy({ ...p, enabled: false, removed: true, removedAt: at, pending: undefined }));
    removed.push(p.id);
  }
  out.push(...manual);
  const toTest = pendingIds(out).slice(0, limits.maxNew ?? MAX_NEW_TESTS);
  const toRetest = out
    .filter((m) => !m.manual && !m.removed && !m.manualOff && !m.pending && m.lastTest?.ok === false)
    .sort((a, b) => testedAt(a) - testedAt(b))
    .slice(0, limits.maxRetest ?? MAX_RETESTS)
    .map((m) => m.id);
  return { models: out, added, removed, returned, toTest, toRetest };
}

// Models waiting for their first sync test.
export function pendingIds(models: StoredModel[]): string[] {
  return models.filter((m) => m.pending === true && !m.removed && !m.manual && !m.manualOff).map((m) => m.id);
}

// Applies the run's test results to the (freshly re-read) list. `ready` = models that went from new or failing to
// passing and are on now (the Telegram line). A pending model that fails stays off; a re-test that fails changes
// only lastTest. The owner's manualOff wins over a pass.
export function applyTestResults(models: StoredModel[], results: { id: string; test: ModelTest }[]): { models: StoredModel[]; ready: string[] } {
  const byId = new Map(results.map((r) => [r.id, r.test]));
  const ready: string[] = [];
  const next = models.map((m) => {
    const test = byId.get(m.id);
    if (!test || m.manual || m.removed) return m;
    const wasNewOrFailing = m.pending === true || m.lastTest?.ok === false || !m.lastTest;
    if (test.ok) {
      const enabled = m.manualOff ? m.enabled : true;
      if (enabled && wasNewOrFailing) ready.push(m.id);
      return tidy({ ...m, enabled, pending: undefined, lastTest: test });
    }
    return tidy({ ...m, enabled: m.pending ? false : m.enabled, pending: undefined, lastTest: test });
  });
  return { models: next, ready };
}

// ---- throttle ----

export type SyncSummary = { listed: number; added: number; removed: number; returned: number; tested: number; ready: number };
export type SyncState = { lastRunAt: string | null; finishedAt?: string; pending?: boolean; error?: string; summary?: SyncSummary };
// One run's result (model-sync-db.ts runs it; here so code without the sync can name the type).
export type ConnSync = { id: string; name: string; ok: boolean; error?: string; listed: number; added: string[]; removed: string[]; returned: string[]; tested: number; ready: string[]; pending: number };
export type SyncRun = { conns: ConnSync[]; summary: SyncSummary; pending: boolean };

export function readSyncState(v: unknown): SyncState {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { lastRunAt: null };
  const o = v as Record<string, unknown>;
  const s = (x: unknown) => (typeof x === "string" && Number.isFinite(Date.parse(x)) ? x : undefined);
  const sum = o.summary && typeof o.summary === "object" ? (o.summary as SyncSummary) : undefined;
  return {
    lastRunAt: s(o.lastRunAt) ?? null, finishedAt: s(o.finishedAt), pending: o.pending === true,
    error: typeof o.error === "string" ? o.error.slice(0, 200) : undefined, summary: sum,
  };
}

// Due: never run, the last run 6 h ago, or new models still wait for a test and the last run is 5 min old.
export function syncDue(now: Date, state: SyncState): boolean {
  if (!state.lastRunAt) return true;
  const since = now.getTime() - Date.parse(state.lastRunAt);
  return since >= SYNC_EVERY_MS || (state.pending === true && since >= PENDING_RETRY_MS);
}

// The in-memory slot: a warm instance reads the stored state at most once per CHECK_EVERY_MS.
export function checkDue(now: Date, lastCheck: number | null): boolean {
  return lastCheck === null || now.getTime() - lastCheck >= CHECK_EVERY_MS;
}

// When the next automatic run is expected, for "next in Y" on Models.
export function nextSyncAt(state: SyncState): Date | null {
  if (!state.lastRunAt) return null;
  return new Date(Date.parse(state.lastRunAt) + (state.pending ? PENDING_RETRY_MS : SYNC_EVERY_MS));
}

// ---- Telegram ----

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// One line per model that is ready, one line per connection listing the models it removed. null = nothing to say.
export function syncMessage(runs: { name: string; ready: string[]; removed: string[] }[], lang: NotifyLang = "en"): string | null {
  const id = lang === "id";
  const lines: string[] = [];
  for (const r of runs) for (const m of r.ready) lines.push(`✅ ${id ? "Model baru siap dipakai" : "New model ready to use"}: ${esc(m)}`);
  for (const r of runs) if (r.removed.length) lines.push(`🗑 ${id ? "Model dihapus dari" : "Model removed from"} ${esc(r.name)}: ${r.removed.map(esc).join(", ")}`);
  return lines.length ? lines.join("\n") : null;
}

export const isNewModel = (m: { addedAt?: string | null }, now: Date): boolean =>
  !!m.addedAt && now.getTime() - Date.parse(m.addedAt) < NEW_BADGE_MS;

// ---- Models page ----

const span = (ms: number) => {
  const m = Math.round(Math.abs(ms) / 60_000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
};

// "Auto-sync: on · last sync 2 h ago · next in 4 h" (pure).
export function syncStatusText(state: SyncState, now: Date): string {
  if (!state.lastRunAt) return "Auto-sync: on · not synced yet · next within minutes";
  const last = `last sync ${span(now.getTime() - Date.parse(state.lastRunAt))} ago`;
  const next = nextSyncAt(state)!.getTime() - now.getTime();
  return `Auto-sync: on · ${last} · ${next <= 60_000 ? "next within minutes" : `next in ${span(next)}`}`;
}
