import type { ActionResult } from "@/lib/action";
import { type CreateInputs, type CreateResult, type CreateStatus, type CreateType, CREATE_TYPES, REQUEST_TTL_MS, summaryOf, TYPE_LABEL } from "./types";

// Stage 6 create requests: request → check → Owner approval (aal2, checked by the caller) → re-check → ONE create call
// (spec 2026-10-15 §4). Everything with a side effect comes in through FlowDeps, so the whole flow is tested without a
// database or a network. The one-time secret a create may return (a Supabase database password) goes back to the
// approver in the result's data and nowhere else: not to finish(), not to audit(), not to a log.

export type Requester = { id: string; userId: string | null };
export type Prepared = { inputs: CreateInputs; accountId: string | null; targetResourceId: string | null; targetLabel: string; cost: string };
export type PrepareResult = { ok: true; p: Prepared } | { ok: false; error: string; field?: string };
export type RunOutcome =
  | { ok: true; result: CreateResult; message: string; secret?: string }
  // checked: the live re-check refused it, so nothing was sent. maybe: no answer to the create call; it may exist.
  | { ok: false; error: string; checked: boolean; maybe?: boolean };

export type RowLike = {
  id: string; type: CreateType; status: CreateStatus; inputs: CreateInputs; requestedBy: string; accountId: string | null;
  targetResourceId: string | null; targetLabel: string; expiresAt: Date;
};

export type Executor = {
  prepare: (target: string, raw: unknown) => Promise<PrepareResult>;
  run: (row: RowLike) => Promise<RunOutcome>;
};

export type FlowDeps = {
  now: () => Date;
  quota: (memberId: string, key: string) => Promise<string | null>; // the provider-action quota (10 per 10 min)
  limitRequest: (memberId: string) => Promise<boolean>;             // 3 creates per member per day
  executor: (t: CreateType) => Executor;
  insert: (row: Omit<RowLike, "id" | "status"> & { provider: string }) => Promise<RowLike>;
  get: (id: string) => Promise<RowLike | null>;
  decide: (id: string, decision: "approve" | "reject", memberId: string, now: Date) => Promise<RowLike | null>;
  claim: (id: string, now: Date) => Promise<RowLike | null>;
  finish: (id: string, p: { ok: boolean; result?: CreateResult | null; error?: string | null }, now: Date) => Promise<void>;
  audit: (e: { kind: "ok" | "err"; message: string; detail?: string; resourceId: string | null; actorUserId: string | null }) => Promise<void>;
  notify: (row: RowLike) => Promise<void>;
};

export const LIMIT_TEXT = "You've asked for 3 creates today, the daily limit. Try again tomorrow.";
export const EXPIRED_TEXT = "This request expired (requests last 24 hours) or was already decided. Ask again if it's still needed.";
export const TYPED_TEXT = "Type the new resource's name exactly to approve it.";
const isType = (t: unknown): t is CreateType => typeof t === "string" && (CREATE_TYPES as readonly string[]).includes(t);
const provider = (t: CreateType) => ({ dns_record: "cloudflare", neon_branch: "neon", supabase_project: "supabase", firebase_project: "firebase" })[t];
const quiet = async (p: Promise<unknown>) => { try { await p; } catch { console.warn("create: audit or notice failed"); } };

export async function requestCreate(member: Requester, type: unknown, target: unknown, raw: unknown, deps: FlowDeps): Promise<ActionResult<{ id: string; cost: string }>> {
  if (!isType(type) || typeof target !== "string" || target.length > 100) return { ok: false, error: "Something in that request wasn't valid." };
  const q = await deps.quota(member.id, `create:${type}`);
  if (q) return { ok: false, error: q };
  const prep = await deps.executor(type).prepare(target, raw);
  if (!prep.ok) return { ok: false, error: prep.error, ...(prep.field ? { fieldErrors: { [prep.field]: prep.error } } : {}) };
  // Counted only once the request passed its checks: a refused check doesn't use up the day.
  if (!(await deps.limitRequest(member.id))) return { ok: false, error: LIMIT_TEXT };
  const now = deps.now();
  const row = await deps.insert({
    type, provider: provider(type), accountId: prep.p.accountId, targetResourceId: prep.p.targetResourceId, targetLabel: prep.p.targetLabel.slice(0, 120),
    inputs: prep.p.inputs, requestedBy: member.id, expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
  });
  const s = summaryOf(type, row.inputs);
  await quiet(deps.audit({ kind: "ok", message: `Create requested · ${TYPE_LABEL[type]} ${s.confirmName}`, detail: s.summary, resourceId: row.targetResourceId, actorUserId: member.userId }));
  await quiet(deps.notify(row));
  return { ok: true, message: `Asked. ${prep.p.cost} It waits for the Owner's approval for 24 hours.`, data: { id: row.id, cost: prep.p.cost } };
}

export async function rejectCreate(member: Requester, id: unknown, deps: FlowDeps): Promise<ActionResult> {
  if (typeof id !== "string") return { ok: false, error: EXPIRED_TEXT };
  const row = await deps.decide(id, "reject", member.id, deps.now());
  if (!row) return { ok: false, error: EXPIRED_TEXT };
  const s = summaryOf(row.type, row.inputs);
  await quiet(deps.audit({ kind: "ok", message: `Create rejected · ${TYPE_LABEL[row.type]} ${s.confirmName}`, resourceId: row.targetResourceId, actorUserId: member.userId }));
  return { ok: true, message: "Rejected. Nothing was created." };
}

// The caller has proven Owner + aal2. `typed` is the confirmation the Owner typed (the new resource's name).
export async function approveCreate(member: Requester, id: unknown, typed: unknown, deps: FlowDeps): Promise<ActionResult<{ secret?: string; result?: CreateResult }>> {
  if (typeof id !== "string") return { ok: false, error: EXPIRED_TEXT };
  const cur = await deps.get(id);
  if (!cur || cur.status !== "requested" || cur.expiresAt.getTime() <= deps.now().getTime()) return { ok: false, error: EXPIRED_TEXT };
  const s = summaryOf(cur.type, cur.inputs);
  if (typeof typed !== "string" || typed.trim() !== s.confirmName) return { ok: false, error: TYPED_TEXT, fieldErrors: { confirm: TYPED_TEXT } };
  const q = await deps.quota(member.id, `create:${cur.id}`);
  if (q) return { ok: false, error: q };
  if (!(await deps.decide(id, "approve", member.id, deps.now()))) return { ok: false, error: EXPIRED_TEXT };
  const row = await deps.claim(id, deps.now());
  if (!row) return { ok: false, error: "This request is already running." };

  let out: RunOutcome;
  try {
    out = await deps.executor(row.type).run(row);
  } catch (e) {
    console.warn("create run failed:", e instanceof Error ? e.name : "error");
    out = { ok: false, error: "Something went wrong before the create finished. Check the provider's dashboard before asking again.", checked: false, maybe: true };
  }
  const what = `${TYPE_LABEL[row.type]} ${s.confirmName}`;
  const by = row.requestedBy === member.id ? "asked and approved by the Owner" : `asked by member ${row.requestedBy.slice(0, 8)}, approved by the Owner`;
  if (out.ok) {
    await deps.finish(row.id, { ok: true, result: out.result }, deps.now());
    await quiet(deps.audit({ kind: "ok", message: `Created · ${what}`, detail: `${s.summary} · ${by}`, resourceId: row.targetResourceId, actorUserId: member.userId }));
    return { ok: true, message: out.message, data: { result: out.result, ...(out.secret ? { secret: out.secret } : {}) } };
  }
  await deps.finish(row.id, { ok: false, error: out.error }, deps.now());
  await quiet(deps.audit({ kind: "err", message: out.checked ? `Create refused at re-check · ${what}` : `Create failed · ${what}`, detail: `${out.error} · ${by}`, resourceId: row.targetResourceId, actorUserId: member.userId }));
  return { ok: false, error: out.error };
}
