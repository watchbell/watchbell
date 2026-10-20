import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveCreate, EXPIRED_TEXT, type Executor, type FlowDeps, LIMIT_TEXT, rejectCreate, requestCreate, type RowLike, TYPED_TEXT } from "./flow";
import type { CreateStatus } from "./types";

// Stage 6 create requests: request → check → approval → re-check → one create, with every side effect faked.

const NOW = new Date("2026-10-16T10:00:00Z");
const owner = { id: "m-owner-1", userId: "u-owner" };
const operator = { id: "m-oper-22", userId: "u-oper" };
const SECRET = "Sup3rS3cretPassw0rdNeverStored42";
const inputs = { orgSlug: "acme", orgName: "Acme", name: "shop", region: "ap-southeast-1" };

function setup(over: Partial<FlowDeps> = {}, exec: Partial<Executor> = {}) {
  const rows = new Map<string, RowLike>();
  let seq = 0;
  const runs: RowLike[] = [];
  const executor: Executor = {
    prepare: vi.fn(async () => ({ ok: true as const, p: { inputs, accountId: "acc-1", targetResourceId: null, targetLabel: "utama", cost: "Free. Uses 1 of 2." } })),
    run: vi.fn(async (row: RowLike) => { runs.push(row); return { ok: true as const, result: { id: "ref1", name: "shop" }, message: "Project shop is being set up.", secret: SECRET }; }),
    ...exec,
  };
  const cas = (id: string, from: CreateStatus, to: CreateStatus) => {
    const r = rows.get(id);
    if (!r || r.status !== from) return null;
    const next = { ...r, status: to };
    rows.set(id, next);
    return next;
  };
  const deps: FlowDeps = {
    now: () => NOW,
    quota: vi.fn(async () => null),
    limitRequest: vi.fn(async () => true),
    executor: () => executor,
    insert: vi.fn(async (row) => { const r = { ...row, id: `req-${++seq}`, status: "requested" as const }; rows.set(r.id, r); return r; }),
    get: vi.fn(async (id) => rows.get(id) ?? null),
    decide: vi.fn(async (id, d, _m, now) => {
      const r = rows.get(id);
      if (!r || r.expiresAt.getTime() <= now.getTime()) return null;
      return cas(id, "requested", d === "approve" ? "approved" : "rejected");
    }),
    claim: vi.fn(async (id) => cas(id, "approved", "running")),
    finish: vi.fn(async (id, p) => { cas(id, "running", p.ok ? "done" : "failed"); }),
    audit: vi.fn(async () => undefined),
    notify: vi.fn(async () => undefined),
    ...over,
  };
  return { deps, rows, executor, runs };
}

let logs: unknown[][] = [];
beforeEach(() => {
  logs = [];
  for (const m of ["log", "warn", "error", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a); });
});
afterEach(() => vi.restoreAllMocks());

describe("requestCreate", () => {
  it("validates the type first, then quota, then the live check, then the daily limit; stores, audits and notifies", async () => {
    const { deps, rows } = setup();
    const r = await requestCreate(operator, "supabase_project", "acc-1", { name: "shop" }, deps);
    expect(r).toMatchObject({ ok: true, data: { id: "req-1" } });
    const row = rows.get("req-1")!;
    expect(row).toMatchObject({ status: "requested", requestedBy: operator.id, type: "supabase_project", targetLabel: "utama" });
    expect(row.expiresAt.getTime() - NOW.getTime()).toBe(24 * 3_600_000);
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ message: "Create requested · Supabase project shop", actorUserId: operator.userId }));
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(await requestCreate(operator, "vercel_project", "x", {}, deps)).toMatchObject({ ok: false });
  });
  it("3 per member per day: the 4th is refused and nothing is stored", async () => {
    const { deps, rows } = setup({ limitRequest: vi.fn(async () => false) });
    expect(await requestCreate(owner, "dns_record", "zone", {}, deps)).toEqual({ ok: false, error: LIMIT_TEXT });
    expect(rows.size).toBe(0);
    expect(deps.notify).not.toHaveBeenCalled();
  });
  it("a refused live check stores nothing and doesn't use up the day", async () => {
    const { deps, rows } = setup({}, { prepare: vi.fn(async () => ({ ok: false as const, error: "This organization is on the pro plan.", field: "orgSlug" })) });
    expect(await requestCreate(owner, "supabase_project", "acc-1", {}, deps)).toMatchObject({ ok: false, error: expect.stringContaining("pro plan"), fieldErrors: { orgSlug: expect.any(String) } });
    expect(deps.limitRequest).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);
  });
});

describe("approveCreate", () => {
  async function asked(over: Partial<FlowDeps> = {}, exec: Partial<Executor> = {}) {
    const s = setup(over, exec);
    await requestCreate(operator, "supabase_project", "acc-1", {}, s.deps);
    return s;
  }

  it("needs the typed name; then re-checks and makes the ONE create; the row is done", async () => {
    const s = await asked();
    expect(await approveCreate(owner, "req-1", "sho", s.deps)).toMatchObject({ ok: false, error: TYPED_TEXT });
    expect(s.executor.run).not.toHaveBeenCalled();
    const r = await approveCreate(owner, "req-1", "shop", s.deps);
    expect(r).toMatchObject({ ok: true, data: { secret: SECRET, result: { id: "ref1" } } });
    expect(s.executor.run).toHaveBeenCalledTimes(1);
    expect(s.rows.get("req-1")?.status).toBe("done");
    expect(s.deps.audit).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "ok", message: "Created · Supabase project shop", actorUserId: owner.userId, detail: expect.stringContaining("asked by member m-oper-2") }));
  });

  it("the one-time password is returned to the approver only: never in insert, finish, audit or a log", async () => {
    const s = await asked();
    await approveCreate(owner, "req-1", "shop", s.deps);
    const seen = JSON.stringify([
      (s.deps.insert as ReturnType<typeof vi.fn>).mock.calls, (s.deps.finish as ReturnType<typeof vi.fn>).mock.calls,
      (s.deps.audit as ReturnType<typeof vi.fn>).mock.calls, (s.deps.notify as ReturnType<typeof vi.fn>).mock.calls, [...s.rows.values()], logs,
    ]);
    expect(seen).not.toContain(SECRET);
  });

  it("a second approval (double click, another tab) can't create twice", async () => {
    const s = await asked();
    const [a, b] = await Promise.all([approveCreate(owner, "req-1", "shop", s.deps), approveCreate(owner, "req-1", "shop", s.deps)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(s.executor.run).toHaveBeenCalledTimes(1);
    expect(await approveCreate(owner, "req-1", "shop", s.deps)).toEqual({ ok: false, error: EXPIRED_TEXT });
  });

  it("an expired request (24 h) is refused before anything runs", async () => {
    const s = await asked();
    const later = { ...s.deps, now: () => new Date(NOW.getTime() + 24 * 3_600_000 + 1) };
    expect(await approveCreate(owner, "req-1", "shop", later)).toEqual({ ok: false, error: EXPIRED_TEXT });
    expect(s.executor.run).not.toHaveBeenCalled();
    expect(s.rows.get("req-1")?.status).toBe("requested");
  });

  it("the live re-check refusing marks it failed and audits it; nothing is created", async () => {
    const s = await asked({}, { run: vi.fn(async () => ({ ok: false as const, checked: true, error: "2 free projects are already active." })) });
    expect(await approveCreate(owner, "req-1", "shop", s.deps)).toEqual({ ok: false, error: "2 free projects are already active." });
    expect(s.rows.get("req-1")?.status).toBe("failed");
    expect(s.deps.audit).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "err", message: "Create refused at re-check · Supabase project shop" }));
  });

  it("the provider-action quota applies at approval too", async () => {
    const s = await asked();
    s.deps.quota = vi.fn(async () => "Too many actions. Try again in 5 minutes.");
    expect(await approveCreate(owner, "req-1", "shop", s.deps)).toEqual({ ok: false, error: "Too many actions. Try again in 5 minutes." });
    expect(s.rows.get("req-1")?.status).toBe("requested");
  });

  it("a crash in the executor still finishes the row as failed (never stuck running)", async () => {
    const s = await asked({}, { run: vi.fn(async () => { throw new Error(SECRET); }) });
    expect(await approveCreate(owner, "req-1", "shop", s.deps)).toMatchObject({ ok: false });
    expect(s.rows.get("req-1")?.status).toBe("failed");
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });
});

describe("rejectCreate", () => {
  it("moves a waiting request to rejected once", async () => {
    const s = setup();
    await requestCreate(operator, "supabase_project", "acc-1", {}, s.deps);
    expect(await rejectCreate(owner, "req-1", s.deps)).toMatchObject({ ok: true });
    expect(s.rows.get("req-1")?.status).toBe("rejected");
    expect(await rejectCreate(owner, "req-1", s.deps)).toEqual({ ok: false, error: EXPIRED_TEXT });
    expect(await approveCreate(owner, "req-1", "shop", s.deps)).toEqual({ ok: false, error: EXPIRED_TEXT });
  });
});
