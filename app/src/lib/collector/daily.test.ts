import { beforeEach, describe, expect, it, vi } from "vitest";
import { accounts, recommendationDismissals, rollupsHourly } from "@/db/schema";
import { deployDays } from "@/db/report-schema";
import { PgDialect } from "drizzle-orm/pg-core";
import { fakeDb, payloadOf, whereOf } from "@/lib/data/fake-db";
import { RETENTION_DAYS } from "./retention";

const h = vi.hoisted(() => ({
  current: null as null | { db: () => unknown }, revalidateTag: vi.fn(), syncAccount: vi.fn(), taskDatabasesDaily: vi.fn(), runSecurityChecks: vi.fn(), recordEvents: vi.fn(), runAdvisor: vi.fn(),
  recordPing: vi.fn(), runKeepAlive: vi.fn(), monthlyBackupStep: vi.fn(), readRetentionDays: vi.fn(), githubDailyStep: vi.fn(),
}));
vi.mock("@/lib/data/keep-active-db", () => ({ runKeepAlive: h.runKeepAlive }));
vi.mock("@/lib/backup/run", () => ({ monthlyBackupStep: h.monthlyBackupStep }));
vi.mock("@/lib/data/settings-db", () => ({ readRetentionDays: h.readRetentionDays }));
vi.mock("@/lib/data/github-db", () => ({ githubDailyStep: h.githubDailyStep }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("next/cache", () => ({ revalidateTag: h.revalidateTag, updateTag: vi.fn() }));
vi.mock("@/lib/sync-db", () => ({ syncAccount: h.syncAccount }));
vi.mock("./db-tasks", () => ({ taskDatabasesDaily: h.taskDatabasesDaily }));
vi.mock("@/lib/data/security-db", () => ({ runSecurityChecks: h.runSecurityChecks }));
vi.mock("@/lib/data/advisor-db", () => ({ runAdvisor: h.runAdvisor }));
vi.mock("@/lib/data/events-write", () => ({ recordEvents: h.recordEvents }));
vi.mock("@/lib/data/heartbeats-db", () => ({ recordDailyPing: h.recordPing }));
const os = vi.hoisted(() => ({ runOsScan: vi.fn() }));
vi.mock("@/lib/data/os-scan-db", () => ({ runOsScan: os.runOsScan, osState: () => (process.env.WATCHBELL_MODE === "selfhost" ? "on" : "off-cloud") }));
// Watchbell 1.2 (D11): the sections the owner turned off (none unless a test says so).
const sec = vi.hoisted(() => ({ paused: new Set<string>() }));
vi.mock("@/lib/data/sections-db", () => ({ pausedSections: async () => sec.paused }));
// Watchbell 1.7: the daily deploy summary (its own tests in deploy-days.test.ts).
const dd = vi.hoisted(() => ({ stepDeployDays: vi.fn() }));
// Watchbell 1.7: the monthly report sends (their own tests in lib/report/send.test.ts).
const rs = vi.hoisted(() => ({ runReportSends: vi.fn() }));
vi.mock("@/lib/report/send", () => ({ runReportSends: rs.runReportSends }));
vi.mock("./deploy-days", async (orig) => ({ ...(await orig<typeof import("./deploy-days")>()), stepDeployDays: dd.stepDeployDays }));

import { runDaily } from "./daily";

beforeEach(() => {
  for (const f of [h.revalidateTag, h.syncAccount, h.taskDatabasesDaily, h.runSecurityChecks, h.recordEvents, h.recordPing, h.runAdvisor, h.runKeepAlive, h.monthlyBackupStep, h.readRetentionDays, h.githubDailyStep]) f.mockReset();
  h.recordPing.mockResolvedValue("none"); // 27 Nov: every run pings (by the console's link or the env token)
  h.githubDailyStep.mockResolvedValue(null);
  h.monthlyBackupStep.mockResolvedValue(null);
  h.readRetentionDays.mockResolvedValue({ ...RETENTION_DAYS });
  h.runKeepAlive.mockResolvedValue(undefined);
  vi.unstubAllEnvs();
  h.runSecurityChecks.mockResolvedValue({ failed: [] });
  h.runAdvisor.mockResolvedValue([]);
  rs.runReportSends.mockReset();
  rs.runReportSends.mockResolvedValue({ sent: 0, failed: 0, left: 0 });
  sec.paused = new Set();
});

describe("runDaily with paused sections (D11)", () => {
  it("skips a paused section's steps and its providers' account syncs, and runs the rest", async () => {
    sec.paused = new Set(["database", "devops"]);
    // The sync's account list (the only read that answers): one Vercel, one Supabase account.
    const list = [{ id: "acc-v", label: "me", provider: "vercel" }, { id: "acc-s", label: "main", provider: "supabase" }];
    const byTable = (calls: { method: string; args: unknown[] }[]) => (calls.find((c) => c.method === "from")?.args[0] === accounts ? list : []);
    h.current = fakeDb(Array.from({ length: 10 }, () => byTable), [[{ id: "run-1" }]]);
    h.syncAccount.mockResolvedValue({ ok: true, skippedTeams: [], overLimit: null });
    const r = await runDaily();
    expect(h.syncAccount.mock.calls.map((c) => c[0])).toEqual(["acc-v"]);
    expect(h.githubDailyStep).not.toHaveBeenCalled();
    expect(h.taskDatabasesDaily).not.toHaveBeenCalled();
    // Keep active protects the owner's projects: it runs whatever the Database switch says.
    expect(h.runKeepAlive).toHaveBeenCalled();
    expect(h.runSecurityChecks).toHaveBeenCalled();
    expect(r.tasks).toEqual(["rollups", "deploy-days", "backup", "retention", "reports", "sync", "keep-active", "security", "advisor"]);
    expect(r.errors).toEqual([]);
  });
});

describe("runDaily keep-active step (A8)", () => {
  it("runs right after databases, with the run's start and at most 5 s, sharing the run's errors", async () => {
    h.current = fakeDb([], [[{ id: "run-1" }]]);
    const order: string[] = [];
    h.taskDatabasesDaily.mockImplementation(async () => { order.push("databases"); });
    h.runKeepAlive.mockImplementation(async (_at: Date, _deadline: number, errors: string[]) => { order.push("keep-active"); errors.push("keep-active/quillpad: x"); });
    h.runSecurityChecks.mockImplementation(async () => { order.push("security"); return { failed: [] }; });
    const before = Date.now();
    const r = await runDaily();
    expect(order).toEqual(["databases", "keep-active", "security"]);
    const [at, deadline] = h.runKeepAlive.mock.calls[0] as [Date, number];
    expect(at).toBeInstanceOf(Date);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(deadline).toBeGreaterThanOrEqual(before);
    expect(r.tasks).toContain("keep-active");
    expect(r.errors).toEqual(["keep-active/quillpad: x"]);
  });
});

describe("runDaily OS scan (owner 12 Nov)", () => {
  it("a self-hosted console scans its machine after the security check; a scan problem is one line", async () => {
    vi.stubEnv("WATCHBELL_MODE", "selfhost");
    h.current = fakeDb([], [[{ id: "run-1" }]]);
    os.runOsScan.mockReset().mockResolvedValue({ ok: true, data: { status: "error", error: "Couldn't read the waiting updates (apt isn't installed).", updates: [], backlog: { error: null } } });
    const r = await runDaily();
    expect(r.tasks.slice(-2)).toEqual(["os", "advisor"]);
    expect(r.errors).toContain("os: Couldn't read the waiting updates (apt isn't installed).");
  });
  it("an unsupported machine (Windows, Debian) is not a daily failure; failed lookups are (review I1, M7)", async () => {
    vi.stubEnv("WATCHBELL_MODE", "selfhost");
    h.current = fakeDb([], [[{ id: "run-1" }]]);
    os.runOsScan.mockReset().mockResolvedValue({ ok: true, data: { status: "unsupported", error: "OS checks run on Ubuntu for now; this machine is win32.", updates: [], backlog: { error: null } } });
    expect((await runDaily()).errors.filter((e) => e.startsWith("os"))).toEqual([]);
    h.current = fakeDb([], [[{ id: "run-1" }]]);
    os.runOsScan.mockReset().mockResolvedValue({ ok: true, data: { status: "ok", error: null, updates: [{ error: "x" }, { error: null }, { error: "y" }], backlog: { error: "OSV.dev answered HTTP 500." } } });
    expect((await runDaily()).errors.filter((e) => e.startsWith("os"))).toEqual(["os: Ubuntu's data couldn't be read for 2 updates", "os: OSV.dev answered HTTP 500."]);
  });
  it("the cloud edition has no OS step, and a paused DevOps section skips it", async () => {
    h.current = fakeDb([], [[{ id: "run-1" }]]);
    os.runOsScan.mockReset();
    expect((await runDaily()).tasks).not.toContain("os");
    vi.stubEnv("WATCHBELL_MODE", "selfhost");
    sec.paused = new Set(["devops"]);
    h.current = fakeDb([], [[{ id: "run-1" }]]);
    expect((await runDaily()).tasks).not.toContain("os");
    expect(os.runOsScan).not.toHaveBeenCalled();
  });
});

describe("runDaily backup step (stage 7, B4)", () => {
  it("runs after rollups and before the sync, with the run's start and a 20 s stop", async () => {
    h.current = fakeDb([], [[{ id: "run-1" }]]);
    const order: string[] = [];
    h.monthlyBackupStep.mockImplementation(async () => { order.push("backup"); return null; });
    h.taskDatabasesDaily.mockImplementation(async () => { order.push("databases"); });
    const r = await runDaily();
    expect(r.tasks.slice(0, 4)).toEqual(["rollups", "deploy-days", "backup", "retention"]);
    expect(order).toEqual(["backup", "databases"]);
    const [at, deadline] = h.monthlyBackupStep.mock.calls[0] as [Date, number];
    expect(deadline).toBe(at.getTime() + 20_000);
    expect(r.errors).toEqual([]);
  });
  it("syncs GitHub after the account sync and before the databases, within 6 s, reporting its problem in one line", async () => {
    h.current = fakeDb([], [[{ id: "run-1" }]]);
    const order: string[] = [];
    h.githubDailyStep.mockImplementation(async () => { order.push("github"); return "GitHub rejected this token (401). It may have expired or been revoked."; });
    h.taskDatabasesDaily.mockImplementation(async () => { order.push("databases"); });
    const before = Date.now();
    const r = await runDaily();
    expect(order).toEqual(["github", "databases"]);
    expect(r.tasks.indexOf("github")).toBe(r.tasks.indexOf("sync") + 1);
    expect(h.githubDailyStep.mock.calls[0][0]).toBeLessThanOrEqual(Date.now() + 6_000);
    expect(h.githubDailyStep.mock.calls[0][0]).toBeGreaterThanOrEqual(before);
    expect(r.errors).toEqual(["github: GitHub rejected this token (401). It may have expired or been revoked."]);
  });
  it("reports a failed backup as one line without stopping the run", async () => {
    h.current = fakeDb([], [[{ id: "run-1" }]]);
    h.monthlyBackupStep.mockResolvedValue("October 2026: Your Google Drive is full.");
    const r = await runDaily();
    expect(r.errors).toEqual(["backup: October 2026: Your Google Drive is full."]);
    expect(r.tasks).toContain("security");
  });
});

describe("runDaily (perf P3)", () => {
  it("expires every cached list once the sync and the database step have written", async () => {
    // Reads answer empty: no rollups to do, no accounts to sync. The run row insert returns its id.
    h.current = fakeDb([], [[{ id: "run-1" }]]);
    const order: string[] = [];
    h.taskDatabasesDaily.mockImplementation(async () => { order.push("databases"); });
    h.revalidateTag.mockImplementation((tag: string) => { order.push(tag); });
    const r = await runDaily();
    expect(r.errors).toEqual([]);
    expect(order).toEqual(["databases", "db:supabase", "db:neon", "db:firebase", "db:extra", "net:zones", "net:domains", "status"]);
    expect(h.revalidateTag).toHaveBeenCalledWith("status", { expire: 0 });
  });
  it("still expires them when a step failed part-way", async () => {
    h.current = fakeDb([], [[{ id: "run-1" }]]);
    h.taskDatabasesDaily.mockRejectedValue(new Error("Supabase down"));
    const r = await runDaily();
    expect(r.errors[0]).toMatch(/^databases: /);
    expect(h.revalidateTag).toHaveBeenCalledTimes(7);
  });
  it("computes the Advisor's items after the security check, with the run's start time", async () => {
    h.current = fakeDb([], [[{ id: "run-1" }]]);
    const order: string[] = [];
    h.runSecurityChecks.mockImplementation(async () => { order.push("security"); return { failed: [] }; });
    h.runAdvisor.mockImplementation(async () => { order.push("advisor"); return []; });
    const r = await runDaily();
    expect(order).toEqual(["security", "advisor"]);
    expect(r.tasks).toContain("advisor");
    expect(h.runAdvisor).toHaveBeenCalledWith(expect.any(Date));
  });
  it("reports a failed Advisor step without stopping the run", async () => {
    h.current = fakeDb([], [[{ id: "run-1" }]]);
    h.runAdvisor.mockRejectedValue(new Error("boom"));
    const r = await runDaily();
    expect(r.errors[0]).toMatch(/^advisor: /);
    expect(r.tasks).toContain("security");
  });
  it("deletes by the Owner's saved retention (B6), and by the defaults when the setting can't be read", async () => {
    // The cut-off date the rollups delete was sent with (its one parameter).
    const at = (f: ReturnType<typeof fakeDb>) => {
      const w = f.writes.find((x) => x.kind === "delete" && x.table === rollupsHourly)!;
      const q = new PgDialect().sqlToQuery(whereOf(w.calls)!.getSQL() as never);
      return new Date(String(q.params[0]));
    };
    const saved = fakeDb([], [[{ id: "run-1" }]]);
    h.current = saved;
    h.readRetentionDays.mockResolvedValue({ ...RETENTION_DAYS, rollupsHourly: 180 });
    const t0 = Date.now();
    await runDaily();
    const cut = at(saved);
    // 1.7: the deploy summary goes with the rollups (same days), and is written before retention runs.
    expect(dd.stepDeployDays).toHaveBeenCalled();
    const dw = saved.writes.find((x) => x.kind === "delete" && x.table === deployDays)!;
    const dq = new PgDialect().sqlToQuery(whereOf(dw.calls)!.getSQL() as never);
    expect(String(dq.params[0])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Math.round((t0 - new Date(`${String(dq.params[0])}T00:00:00Z`).getTime()) / 86_400_000)).toBeGreaterThanOrEqual(179);
    expect(cut).not.toBeNull();
    expect(Math.round((t0 - cut!.getTime()) / 86_400_000)).toBe(180);
    const fallback = fakeDb([], [[{ id: "run-1" }]]);
    h.current = fallback;
    h.readRetentionDays.mockRejectedValue(new Error("db down"));
    const r = await runDaily();
    expect(Math.round((Date.now() - at(fallback)!.getTime()) / 86_400_000)).toBe(90);
    expect(r.tasks).toContain("retention");
  });
  it("deletes dismissals older than 90 days in the retention step", async () => {
    const f = fakeDb([], [[{ id: "run-1" }]]);
    h.current = f;
    await runDaily();
    expect(f.writes.filter((w) => w.kind === "delete" && w.table === recommendationDismissals)).toHaveLength(1);
  });
});

describe("runDaily: its own heartbeat (U3)", () => {
  const T = "hb_0123456789abcdef0123456789abcdef";
  it("pings ok after a clean run, straight to the database", async () => {
    vi.stubEnv("DAILY_HEARTBEAT_TOKEN", T);
    h.current = fakeDb([], [[{ id: "run-1" }]]);
    h.recordPing.mockResolvedValue("ok");
    await runDaily();
    expect(h.recordPing).toHaveBeenCalledWith(T, "ok", expect.any(Date));
  });
  it("pings fail when a step failed, and a ping that can't be written doesn't fail the run", async () => {
    vi.stubEnv("DAILY_HEARTBEAT_TOKEN", T);
    h.current = fakeDb([], [[{ id: "run-1" }]]);
    h.taskDatabasesDaily.mockRejectedValue(new Error("Supabase down"));
    h.recordPing.mockRejectedValue(new Error("db down"));
    const r = await runDaily();
    expect(h.recordPing).toHaveBeenCalledWith(T, "fail", expect.any(Date));
    expect(r.errors).toHaveLength(1);
  });
  it("still pings by the console's link without a token (27 Nov: a new ping URL can't cut it off)", async () => {
    for (const v of ["", "not-a-token"]) {
      vi.stubEnv("DAILY_HEARTBEAT_TOKEN", v);
      h.current = fakeDb([], [[{ id: "run-1" }]]);
      h.recordPing.mockResolvedValue("none");
      await runDaily();
    }
    expect(h.recordPing).toHaveBeenCalledTimes(2);
    expect(h.recordPing).toHaveBeenNthCalledWith(1, null, "ok", expect.any(Date));
    expect(h.recordPing).toHaveBeenNthCalledWith(2, null, "ok", expect.any(Date));
  });
});

describe("runDaily rollups (U5)", () => {
  it("writes the checks made inside a maintenance window as `maintenance`, out of checks and failures, on insert and on update", async () => {
    const at = new Date(Date.now() - 2 * 3_600_000);
    const row = (o: Record<string, unknown>) => ({ id: "c", monitorId: "m1", at, ok: true, statusCode: 200, latencyMs: 100, error: null, inMaintenance: false, ...o });
    const f = fakeDb([[{ hour: null }], [row({}), row({ ok: false, statusCode: 503, inMaintenance: true }), row({ ok: false, statusCode: null, latencyMs: null, inMaintenance: true })]], [[{ id: "run-1" }]]);
    h.current = f;
    await runDaily();
    const [w] = f.writes.filter((x) => x.kind === "insert" && x.table === rollupsHourly);
    expect(payloadOf(w.calls)).toMatchObject({ monitorId: "m1", checks: 1, failures: 0, status5xx: 0, maintenance: 2 });
    const upsert = w.calls.find((c) => c.method === "onConflictDoUpdate")?.args[0] as { set: Record<string, unknown> };
    expect(upsert.set).toMatchObject({ checks: 1, failures: 0, maintenance: 2 });
  });
});

describe("runDaily report sends (1.7)", () => {
  it("sends the monthly reports after retention, and reports a failed send as one line without stopping", async () => {
    h.current = fakeDb([], [[{ id: "run-1" }]]);
    rs.runReportSends.mockResolvedValue({ sent: 1, failed: 2, left: 1 });
    const r = await runDaily();
    // Review I-3: a deadline inside the 60 s run, so the sync after it keeps its share.
    expect(rs.runReportSends).toHaveBeenCalledWith(expect.any(Date), undefined, expect.any(Number));
    expect(r.tasks.indexOf("reports")).toBe(r.tasks.indexOf("retention") + 1);
    expect(r.errors).toContain("reports: 2 monthly reports not sent yet (retried on the next run, up to the 3rd)");
    expect(r.errors).toContain("reports: 1 left for the next run, time budget used");
    expect(r.tasks).toContain("advisor");
  });
});
