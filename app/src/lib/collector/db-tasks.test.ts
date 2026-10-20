import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { accounts, events, snapshots } from "@/db/schema";
import { fakeDb, payloadOf, whereOf } from "@/lib/data/fake-db";

const h = vi.hoisted(() => ({
  current: null as null | { db: () => unknown },
  listProjects: vi.fn(), databaseSize: vi.fn(), serviceHealth: vi.fn(), apiCounts: vi.fn(), orgPlan: vi.fn(),
  getNeonProject: vi.fn(), listEndpoints: vi.fn(), listBranches: vi.fn(), googleAccessToken: vi.fn(), firestorePing: vi.fn(), authUserCount: vi.fn(),
  autoRestoreHook: vi.fn(),
}));
vi.mock("@/lib/data/keep-active-db", () => ({ autoRestoreHook: h.autoRestoreHook }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: "k" }) }));
vi.mock("@/lib/crypto", () => ({ openOrNull: () => "sbp_fake" }));
vi.mock("@/lib/providers/supabase", async (orig) => ({
  ...(await orig<typeof import("@/lib/providers/supabase")>()),
  listProjects: h.listProjects, databaseSize: h.databaseSize, serviceHealth: h.serviceHealth, apiCounts: h.apiCounts, orgPlan: h.orgPlan,
}));

vi.mock("@/lib/providers/neon", async (orig) => ({
  ...(await orig<typeof import("@/lib/providers/neon")>()),
  getNeonProject: h.getNeonProject, listEndpoints: h.listEndpoints, listBranches: h.listBranches,
}));
vi.mock("@/lib/providers/google", async (orig) => ({
  ...(await orig<typeof import("@/lib/providers/google")>()),
  parseServiceAccount: () => ({ project_id: "p" }), googleAccessToken: h.googleAccessToken,
}));
vi.mock("@/lib/providers/firebase", async (orig) => ({ ...(await orig<typeof import("@/lib/providers/firebase")>()), firestorePing: h.firestorePing, authUserCount: h.authUserCount }));

import { appsWithPausedDatabase, taskDatabasesDaily, taskFirebase, taskNeon, taskSupabase, taskSupabaseUsage } from "./db-tasks";

const now = new Date("2026-10-12T02:12:00Z");
const acc = { id: "acc1", provider: "supabase", label: "utama", credentialCiphertext: "c", credentialIv: "i", status: "ok" };
const res = (id: string, ref: string, name: string) => ({ id, accountId: "acc1", kind: "supabase_project", externalId: ref, name, monitored: true, goneAt: null, meta: {} });
const snap = (id: string, state: string, data: Record<string, unknown> = {}) => ({ resourceId: id, state, stateSince: new Date("2026-10-01T00:00:00Z"), data, collectedAt: now });
const project = (ref: string, status: string) => ({ ref, name: ref, orgSlug: "org-a", region: "ap-southeast-1", createdAt: "", status, pgVersion: "17" });
const ctx = () => ({ now, deadline: Date.now() + 15_000, errors: [] as string[] });

beforeEach(() => {
  h.current = null;
  for (const f of [h.listProjects, h.databaseSize, h.serviceHealth, h.apiCounts, h.orgPlan, h.getNeonProject, h.listEndpoints, h.listBranches, h.googleAccessToken, h.firestorePing, h.authUserCount, h.autoRestoreHook]) f.mockReset();
  h.autoRestoreHook.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("taskSupabase", () => {
  it("writes each watched project's state, and an event when one pauses", async () => {
    const f = fakeDb([[acc], [{ r: res("r1", "aaaaaaaaaaaaaaaaaaaa", "quillpad"), s: snap("r1", "ok") }, { r: res("r2", "bbbbbbbbbbbbbbbbbbbb", "portfolio"), s: null }]]);
    h.current = f;
    h.listProjects.mockResolvedValue({ ok: true, data: [project("aaaaaaaaaaaaaaaaaaaa", "INACTIVE"), project("bbbbbbbbbbbbbbbbbbbb", "ACTIVE_HEALTHY")] });
    const c = ctx();
    await taskSupabase(c);
    expect(c.errors).toEqual([]);
    const snaps = f.writes.filter((w) => w.table === snapshots).map((w) => payloadOf(w.calls));
    expect(snaps.map((p) => [p?.resourceId, p?.state])).toEqual([["r1", "paused"], ["r2", "ok"]]);
    expect((snaps[0]?.data as Record<string, unknown>).pausedBeforeSeen).toBe(false);
    // Through recordEvents: a bump attempt (update) first, then the insert with its reason.
    expect(f.writes.filter((w) => w.table === events).map((w) => w.kind)).toEqual(["update", "insert"]);
    const ev = f.writes.find((w) => w.table === events && w.kind === "insert");
    expect(payloadOf(ev!.calls)).toEqual(expect.objectContaining({ resourceId: "r1", type: "database", kind: "paused", message: "Supabase project paused", reason: "DatabasePaused", count: 1 }));
  });

  it("marks the account broken and its projects unknown when Supabase rejects the token (D6)", async () => {
    const f = fakeDb([[acc], [{ r: res("r1", "aaaaaaaaaaaaaaaaaaaa", "quillpad"), s: snap("r1", "paused") }]]);
    h.current = f;
    h.listProjects.mockResolvedValue({ ok: false, kind: "auth", status: 401, error: "Supabase rejected this credential (401)." });
    const c = ctx();
    await taskSupabase(c);
    expect(payloadOf(f.writes.find((w) => w.table === accounts)!.calls)).toMatchObject({ status: "error", lastError: "Supabase rejected this credential (401)." });
    const s = payloadOf(f.writes.find((w) => w.table === snapshots)!.calls);
    expect(s).toMatchObject({ state: "unknown", data: { lastGoodState: "paused" } });
    expect(f.writes.some((w) => w.table === events)).toBe(false);
    expect(c.errors).toEqual(["supabase/utama: Supabase rejected this credential (401)."]);
  });

  it("hands every status it just read to Auto-restore, unwatched projects with a null id (A8)", async () => {
    h.current = fakeDb([[acc], [{ r: res("r1", "aaaaaaaaaaaaaaaaaaaa", "quillpad"), s: snap("r1", "paused") }]]);
    h.listProjects.mockResolvedValue({ ok: true, data: [project("aaaaaaaaaaaaaaaaaaaa", "INACTIVE"), project("cccccccccccccccccccc", "ACTIVE_HEALTHY")] });
    const c = ctx();
    await taskSupabase(c);
    expect(h.autoRestoreHook).toHaveBeenCalledWith(now, [
      { resourceId: "r1", accountId: "acc1", status: "INACTIVE", orgSlug: "org-a" },
      { resourceId: null, accountId: "acc1", status: "ACTIVE_HEALTHY", orgSlug: "org-a" },
    ], c.deadline);
    expect(c.errors).toEqual([]);
  });

  it("an Auto-restore failure is one short line and never fails the status task", async () => {
    const f = fakeDb([[acc], [{ r: res("r1", "aaaaaaaaaaaaaaaaaaaa", "quillpad"), s: snap("r1", "paused") }]]);
    h.current = f;
    h.listProjects.mockResolvedValue({ ok: true, data: [project("aaaaaaaaaaaaaaaaaaaa", "INACTIVE")] });
    h.autoRestoreHook.mockRejectedValue(new Error("db down: secret detail"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const c = ctx();
    await expect(taskSupabase(c)).resolves.toBeUndefined();
    expect(c.errors).toEqual(["auto-restore failed"]);
    expect(f.writes.some((w) => w.table === snapshots)).toBe(true);
    warn.mockRestore();
  });

  it("doesn't call Auto-restore when the project list couldn't be read", async () => {
    h.current = fakeDb([[acc], [{ r: res("r1", "aaaaaaaaaaaaaaaaaaaa", "quillpad"), s: snap("r1", "paused") }]]);
    h.listProjects.mockResolvedValue({ ok: false, kind: "transient", error: "Couldn't reach Supabase." });
    await taskSupabase(ctx());
    expect(h.autoRestoreHook).not.toHaveBeenCalled();
  });

  it("starts nothing once the run's time is used up", async () => {
    h.current = fakeDb([[acc]]);
    await expect(taskSupabase({ now, deadline: Date.now() - 1, errors: [] })).rejects.toThrow("time budget used");
    expect(h.listProjects).not.toHaveBeenCalled();
  });
});

describe("taskDatabasesDaily (D1)", () => {
  it("reads the size only of a healthy project with API traffic in the last 24 h", async () => {
    const recent = new Date(now.getTime() - 3_600_000).toISOString();
    const old = new Date(now.getTime() - 3 * 86_400_000).toISOString();
    const f = fakeDb([
      [acc],
      [
        { r: res("r1", "aaaaaaaaaaaaaaaaaaaa", "portfolio"), s: snap("r1", "ok", { status: "ACTIVE_HEALTHY", lastTrafficAt: recent }) },
        { r: res("r2", "bbbbbbbbbbbbbbbbbbbb", "dormant"), s: snap("r2", "ok", { status: "ACTIVE_HEALTHY", lastTrafficAt: old }) },
        { r: res("r3", "cccccccccccccccccccc", "paused"), s: snap("r3", "paused", { status: "INACTIVE", lastTrafficAt: recent }) },
      ],
      [], // no Firebase accounts
    ]);
    h.current = f;
    h.databaseSize.mockResolvedValue({ ok: true, data: 148_897_792 });
    await taskDatabasesDaily(ctx());
    expect(h.databaseSize.mock.calls.map((c) => c[1])).toEqual(["aaaaaaaaaaaaaaaaaaaa"]);
    expect(f.writes.filter((w) => w.table === snapshots && w.kind === "update")).toHaveLength(1);
  });

  it("stores a missing database_read as the size's reason, without touching the account", async () => {
    const recent = new Date(now.getTime() - 3_600_000).toISOString();
    const f = fakeDb([[acc], [{ r: res("r1", "aaaaaaaaaaaaaaaaaaaa", "portfolio"), s: snap("r1", "ok", { status: "ACTIVE_HEALTHY", lastTrafficAt: recent }) }], []]);
    h.current = f;
    h.databaseSize.mockResolvedValue({ ok: false, kind: "scope", missing: ["database_read"], error: "Missing permission: database_read." });
    await taskDatabasesDaily(ctx());
    expect(f.writes.some((w) => w.table === accounts)).toBe(false);
    expect(f.writes.filter((w) => w.table === snapshots)).toHaveLength(1);
  });
});

// I2: the run has a time budget, and a slow provider must not carry it past that.
describe("the run deadline, inside a task", () => {
  const active = (id: string, ref: string) => ({ r: res(id, ref, id), s: snap(id, "ok", { status: "ACTIVE_HEALTHY", orgSlug: "org-a" }) });

  it("caps every call's timeout at the time left, never above 5 s", async () => {
    h.current = fakeDb([[acc], [{ r: res("r1", "aaaaaaaaaaaaaaaaaaaa", "p"), s: null }], [acc], [{ r: res("r1", "aaaaaaaaaaaaaaaaaaaa", "p"), s: null }]]);
    h.listProjects.mockResolvedValue({ ok: true, data: [project("aaaaaaaaaaaaaaaaaaaa", "ACTIVE_HEALTHY")] });
    await taskSupabase({ now, deadline: Date.now() + 2_500, errors: [] });
    expect(h.listProjects.mock.calls[0][1].timeoutMs).toBeGreaterThan(0);
    expect(h.listProjects.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(2_000);
    await taskSupabase({ now, deadline: Date.now() + 60_000, errors: [] });
    expect(h.listProjects.mock.calls[1][1].timeoutMs).toBe(5_000);
  });

  it("starts no more projects once the time is up, keeps what finished, and leaves the task due", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const items = ["a", "b", "c", "d", "e"].map((x, i) => active(`r${i}`, x.repeat(20)));
    const f = fakeDb([[acc], items]);
    h.current = f;
    h.orgPlan.mockResolvedValue({ ok: true, data: "free" });
    // The first three run together; each one takes the rest of the run's time.
    h.serviceHealth.mockImplementation(async () => { await Promise.resolve(); vi.setSystemTime(Date.now() + 30_000); return { ok: true, data: [] }; });
    h.apiCounts.mockResolvedValue({ ok: true, data: [] });
    await expect(taskSupabaseUsage({ now, deadline: Date.now() + 20_000, errors: [] })).rejects.toThrow("time budget used");
    expect(h.serviceHealth).toHaveBeenCalledTimes(3);
    expect(f.writes.filter((w) => w.table === snapshots && w.kind === "update")).toHaveLength(3);
  });

  it("checks the time before each organization's plan, too", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const two = [
      { r: res("r1", "a".repeat(20), "one"), s: snap("r1", "ok", { status: "INACTIVE", orgSlug: "org-a" }) },
      { r: res("r2", "b".repeat(20), "two"), s: snap("r2", "ok", { status: "INACTIVE", orgSlug: "org-b" }) },
    ];
    h.current = fakeDb([[acc], two]);
    h.orgPlan.mockImplementation(async () => { vi.setSystemTime(Date.now() + 30_000); return { ok: true, data: "free" }; });
    await expect(taskSupabaseUsage({ now, deadline: Date.now() + 20_000, errors: [] })).rejects.toThrow("time budget used");
    expect(h.orgPlan).toHaveBeenCalledTimes(1);
  });

  it("saves the Neon projects that were read and leaves the task due when the rest didn't start", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const neonRes = (id: string) => ({ ...res(id, `ref-${id}`, id), kind: "neon_project" });
    const ep = { ok: true, data: [{ id: "ep", branchId: "b", state: "idle", pendingState: null, disabled: false, minCu: 0.25, maxCu: 2, lastActive: null }] };
    const f = fakeDb([[{ ...acc, provider: "neon" }], ["a", "b", "c", "d"].map((id) => ({ r: neonRes(id), s: null }))]);
    h.current = f;
    h.getNeonProject.mockImplementation(async () => {
      await Promise.resolve();
      vi.setSystemTime(Date.now() + 30_000);
      return { ok: true, data: { computeSeconds: 100, transferBytes: 1, periodStart: null, periodEnd: null, region: "aws-ap-southeast-1", pgVersion: 17, lastActive: null } };
    });
    h.listEndpoints.mockResolvedValue(ep);
    h.listBranches.mockResolvedValue({ ok: true, data: [] });
    await expect(taskNeon({ now, deadline: Date.now() + 20_000, errors: [] })).rejects.toThrow("time budget used");
    expect(h.getNeonProject).toHaveBeenCalledTimes(3);
    expect(f.writes.filter((w) => w.table === snapshots)).toHaveLength(3);
  });
});

// I4: a missing role is named on the page, from the failure's kind and reason.
describe("taskFirebase", () => {
  const fsRes = { ...res("f1", "nova-wallet", "nova-wallet"), kind: "firestore" };
  const fbAcc = { ...acc, provider: "firebase" };

  it("stores why a Firestore read failed, so the page can say which role is missing", async () => {
    const f = fakeDb([[fbAcc], [{ r: fsRes, s: snap("f1", "ok") }]]);
    h.current = f;
    h.googleAccessToken.mockResolvedValue({ ok: true, data: "tok" });
    h.firestorePing.mockResolvedValue({ ok: false, kind: "scope", status: 403, reason: "PERMISSION_DENIED", error: "Firestore refused this request (PERMISSION_DENIED)." });
    await taskFirebase(ctx());
    const s = payloadOf(f.writes.find((w) => w.table === snapshots)!.calls);
    expect(s).toMatchObject({ state: "err", data: { pingKind: "scope", pingReason: "PERMISSION_DENIED" } });
  });
});

// I1: only a database the console still watches can degrade an app.
describe("appsWithPausedDatabase", () => {
  it("is empty without apps and asks nothing", async () => {
    const f = fakeDb([]);
    h.current = f;
    expect(await appsWithPausedDatabase([])).toEqual(new Set());
    expect(f.queries).toHaveLength(0);
  });

  it("counts a paused database, or one that was paused before the provider stopped answering", async () => {
    h.current = fakeDb([[
      { app: "a1", state: "paused", data: {} },
      { app: "a2", state: "unknown", data: { lastGoodState: "paused" } },
      { app: "a3", state: "ok", data: {} },
      { app: "a4", state: "unknown", data: { lastGoodState: "ok" } },
    ]]);
    expect(await appsWithPausedDatabase(["a1", "a2", "a3", "a4"])).toEqual(new Set(["a1", "a2"]));
  });

  it("reads only databases that are watched and not gone: an unticked one's frozen state is not news", async () => {
    const f = fakeDb([[]]);
    h.current = f;
    await appsWithPausedDatabase(["a1"]);
    const q = new PgDialect().sqlToQuery(whereOf(f.queries[0])!.getSQL() as never);
    expect(q.sql).toContain('"monitored" = $');
    expect(q.params).toContain(true);
    expect(q.sql).toContain('"gone_at" is null');
  });
});

describe("taskDatabasesDaily, sharing the time", () => {
  it("still counts Firebase users when the Supabase sizes used up their share, then leaves the step due", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const recent = new Date(now.getTime() - 3_600_000).toISOString();
    const items = ["a", "b"].map((x, i) => ({ r: res(`r${i}`, x.repeat(20), `p${i}`), s: snap(`r${i}`, "ok", { status: "ACTIVE_HEALTHY", lastTrafficAt: recent }) }));
    const fs = { ...res("f1", "nova-wallet", "nova-wallet"), kind: "firestore" };
    h.current = fakeDb([[acc], items, [{ ...acc, provider: "firebase" }], [{ r: fs, s: snap("f1", "ok") }]]);
    h.databaseSize.mockImplementation(async () => { await Promise.resolve(); vi.setSystemTime(Date.now() + 11_000); return { ok: true, data: 1 }; });
    h.googleAccessToken.mockResolvedValue({ ok: true, data: "tok" });
    h.authUserCount.mockResolvedValue({ ok: true, data: 42 });
    await expect(taskDatabasesDaily({ now, deadline: Date.now() + 15_000, errors: [] })).rejects.toThrow("time budget used");
    expect(h.databaseSize).toHaveBeenCalledTimes(1); // the second project waits for tomorrow
    expect(h.authUserCount).toHaveBeenCalledTimes(1);
  });
});
