import { describe, expect, it, vi } from "vitest";
import { ACTIONS_COPY } from "@/lib/copy/edition";
import { type RunDeps, runProposalAction } from "./proposals-run";

const APP = "123e4567-e89b-42d3-a456-426614174000";
const MON = "723e4567-e89b-42d3-a456-426614174000";
const owner = { id: "m1", userId: "u1" };

const deps = (o: Partial<Record<keyof RunDeps, unknown>> = {}): RunDeps => ({
  checkMonitorNow: vi.fn().mockResolvedValue({ ok: true, message: "Check passed: 200 in 120 ms.", passed: true, audit: { message: "Check now: site.example/", resourceId: APP } }),
  keepAliveNow: vi.fn().mockResolvedValue({ ok: true, message: "Keep-alive sent." }),
  wakeAs: vi.fn().mockResolvedValue({ ok: true, message: "Waking." }),
  supabaseAct: vi.fn().mockResolvedValue({ ok: true, message: "Restoring." }),
  redeployAs: vi.fn().mockResolvedValue({ ok: true, message: "Redeploy requested." }),
  rollbackAs: vi.fn().mockResolvedValue({ ok: true, message: "Rolled back." }),
  finish: vi.fn().mockResolvedValue({ ok: true }),
  recordAction: vi.fn().mockResolvedValue(undefined),
  limit: vi.fn().mockResolvedValue({ allowed: true, retryAfter: 0 }),
  ...o,
}) as unknown as RunDeps;
const mock = (f: unknown) => f as ReturnType<typeof vi.fn>;

describe("runProposalAction", () => {
  it.each([
    ["vercel_redeploy", "redeployAs", "dpl_cur00000001"],
    ["vercel_rollback", "rollbackAs", "dpl_prv00000001"],
    ["neon_wake", "wakeAs", "ep-a-1"],
  ] as const)("%s calls the console core %s with the owner as actor and a no-refresh finisher", async (action, fn, ref) => {
    const d = deps();
    expect(await runProposalAction({ action, resourceId: APP, targetRef: ref }, owner, d)).toMatchObject({ ok: true });
    const call = mock(d[fn]).mock.calls[0];
    expect(call.slice(0, 3)).toEqual([{ id: "m1", userId: "u1" }, APP, ref]);
    await call[3]({ done: false, message: "x" }, call[0], "acc");
    expect(d.finish).toHaveBeenCalledWith({ done: false, message: "x" }, call[0], "acc", { refresh: false });
  });

  it("supabase_restore and keep-alive use the Supabase cores", async () => {
    const d = deps();
    await runProposalAction({ action: "supabase_restore", resourceId: APP, targetRef: "abcdefghijklmnopqrst" }, owner, d);
    expect(d.supabaseAct).toHaveBeenCalledWith("restore", owner, APP, "abcdefghijklmnopqrst", expect.any(Function));
    await runProposalAction({ action: "supabase_keepalive", resourceId: APP, targetRef: "abcdefghijklmnopqrst" }, owner, d);
    expect(d.keepAliveNow).toHaveBeenCalledWith(owner, APP, expect.any(Function));
  });

  it("auto-run acts as office-auto: no audit actor, prefixed message", async () => {
    const d = deps();
    await runProposalAction({ action: "vercel_redeploy", resourceId: APP, targetRef: "dpl_cur00000001" }, "auto", d);
    const call = mock(d.redeployAs).mock.calls[0];
    expect(call[0]).toEqual({ id: "office-auto", userId: null });
    await call[3]({ done: false, message: "x" }, call[0], "acc");
    expect(d.finish).toHaveBeenCalledWith(expect.anything(), call[0], "acc", { refresh: false, auditPrefix: ACTIONS_COPY.auditPrefix });
    await runProposalAction({ action: "recheck", resourceId: APP, targetRef: MON }, "auto", d);
    expect(d.limit).toHaveBeenCalledWith(expect.objectContaining({ name: "check" }), "office-auto");
    expect(d.recordAction).toHaveBeenCalledWith({ kind: "ok", message: `${ACTIONS_COPY.auditPrefix}Check now: site.example/`, resourceId: APP, actorUserId: null });
  });

  it("domain_recheck (owner 17 Oct): the domain-check quota, the console's re-check, an audit row", async () => {
    const DOM = "623e4567-e89b-42d3-a456-426614174000";
    const recheckDomain = vi.fn().mockResolvedValue({ ok: true, message: "Checked shop.example.com.", audit: { message: "Re-check: shop.example.com", resourceId: DOM } });
    const d = deps({ recheckDomain });
    expect(await runProposalAction({ action: "domain_recheck", resourceId: DOM, targetRef: DOM }, "auto", d)).toEqual({ ok: true, message: "Checked shop.example.com." });
    expect(d.limit).toHaveBeenCalledWith(expect.objectContaining({ name: "domain-check" }), "office-auto");
    expect(recheckDomain).toHaveBeenCalledWith(DOM);
    expect(d.recordAction).toHaveBeenCalledWith({ kind: "ok", message: `${ACTIONS_COPY.auditPrefix}Re-check: shop.example.com`, resourceId: DOM, actorUserId: null });
    const busy = deps({ recheckDomain, limit: vi.fn().mockResolvedValue({ allowed: false, retryAfter: 60 }) });
    expect(await runProposalAction({ action: "domain_recheck", resourceId: DOM, targetRef: DOM }, owner, busy)).toMatchObject({ ok: false });
    const gone = deps({ recheckDomain: vi.fn().mockResolvedValue({ ok: false, error: "That domain is no longer watched." }) });
    expect(await runProposalAction({ action: "domain_recheck", resourceId: DOM, targetRef: DOM }, owner, gone)).toEqual({ ok: false, error: "That domain is no longer watched." });
  });

  describe("daily_rerun (owner 19 Oct)", () => {
    const t = { action: "daily_rerun", resourceId: APP, targetRef: MON } as const;
    const now = new Date("2026-10-19T10:00:00Z");
    const target = () => ({ url: "https://console.example/api/daily", secret: "s3cret-s3cret-s3cret" });
    const run = (o: Record<string, unknown>) => deps({ now: () => now, dailyTarget: target, lastDailyRunAt: vi.fn().mockResolvedValue(null), ...o });
    it("refuses within 6 hours of the last daily run and never calls fetch", async () => {
      const f = vi.fn();
      const d = run({ fetch: f, lastDailyRunAt: vi.fn().mockResolvedValue(new Date(now.getTime() - 5 * 3_600_000)) });
      expect(await runProposalAction(t, owner, d)).toEqual({ ok: false, error: "The daily job ran less than 6 hours ago." });
      expect(f).not.toHaveBeenCalled();
    });
    it("calls /api/daily with the cron secret and a 40 s timeout; 200 is ok", async () => {
      const f = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      const d = run({ fetch: f, lastDailyRunAt: vi.fn().mockResolvedValue(new Date(now.getTime() - 7 * 3_600_000)) });
      expect(await runProposalAction(t, owner, d)).toEqual({ ok: true, message: "Daily job ran again (200)." });
      expect(f).toHaveBeenCalledWith("https://console.example/api/daily", expect.objectContaining({ headers: { Authorization: "Bearer s3cret-s3cret-s3cret" }, signal: expect.any(AbortSignal) }));
    });
    it.each([401, 500])("a %i answer is a failure", async (status) => {
      expect(await runProposalAction(t, owner, run({ fetch: vi.fn().mockResolvedValue({ ok: false, status }) }))).toEqual({ ok: false, error: `The daily job route answered ${status}.` });
    });
    it("a 3xx answer is a failure and redirects are not followed", async () => {
      const f = vi.fn().mockResolvedValue({ ok: false, status: 302 });
      expect(await runProposalAction(t, owner, run({ fetch: f }))).toEqual({ ok: false, error: "The daily job route answered 302." });
      expect(f).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: "manual" }));
    });
    it.each(["TimeoutError", "AbortError"])("a %s counts as started, not failed (the route keeps running)", async (name) => {
      const e = Object.assign(new Error("aborted"), { name });
      expect(await runProposalAction(t, owner, run({ fetch: vi.fn().mockRejectedValue(e) })))
        .toEqual({ ok: true, message: "Daily job started; it's still running — the heartbeat turns Up when it finishes." });
    });
    it("cuts the call at 40 s", async () => {
      const spy = vi.spyOn(AbortSignal, "timeout");
      await runProposalAction(t, owner, run({ fetch: vi.fn().mockResolvedValue({ ok: true, status: 200 }) }));
      expect(spy).toHaveBeenCalledWith(40_000);
      spy.mockRestore();
    });
    it("any other thrown error is the generic failure, with the secret in neither the result nor the log", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const r = await runProposalAction(t, owner, run({ fetch: vi.fn().mockRejectedValue(new Error("boom s3cret-s3cret-s3cret")) }));
      expect(r).toEqual({ ok: false, error: "Something went wrong while running it. Check the console page before trying again." });
      expect(JSON.stringify([r, warn.mock.calls])).not.toContain("s3cret");
      warn.mockRestore();
    });
    it("missing scheduler settings is a failure without a call", async () => {
      const f = vi.fn();
      expect(await runProposalAction(t, owner, run({ fetch: f, dailyTarget: () => null }))).toMatchObject({ ok: false });
      expect(f).not.toHaveBeenCalled();
    });
  });

  it("recheck honours the check quota and passes a refusal on", async () => {
    const d = deps({ limit: vi.fn().mockResolvedValue({ allowed: false, retryAfter: 120 }) });
    expect(await runProposalAction({ action: "recheck", resourceId: APP, targetRef: MON }, owner, d)).toMatchObject({ ok: false });
    expect(d.checkMonitorNow).not.toHaveBeenCalled();
    const e = deps({ checkMonitorNow: vi.fn().mockResolvedValue({ ok: false, error: "That monitor no longer exists." }) });
    expect(await runProposalAction({ action: "recheck", resourceId: APP, targetRef: MON }, owner, e)).toEqual({ ok: false, error: "That monitor no longer exists." });
  });

  it("a missing target or a thrown error is a failed result, never a throw", async () => {
    expect((await runProposalAction({ action: "recheck", resourceId: APP, targetRef: null }, owner, deps())).ok).toBe(false);
    const d = deps({ redeployAs: vi.fn().mockRejectedValue(new Error("boom")) });
    expect((await runProposalAction({ action: "vercel_redeploy", resourceId: APP, targetRef: "dpl_cur00000001" }, owner, d)).ok).toBe(false);
  });
});

describe("github_bump_pr (automatic security fixes)", () => {
  const REPO = "55555555-5555-4555-8555-555555555555";
  it("an approved one runs as before; an auto one carries the owner's severities; off → refused", async () => {
    const bumpPrAs = vi.fn().mockResolvedValue({ ok: true, message: "Pull request #12 opened" });
    const autoSecurity = vi.fn().mockResolvedValue({ enabled: true, severities: ["critical"], sameMajorOnly: true });
    await runProposalAction({ action: "github_bump_pr", resourceId: APP, targetRef: REPO, proposalId: "p1" }, owner, deps({ bumpPrAs, autoSecurity }));
    expect(bumpPrAs).toHaveBeenLastCalledWith(owner, APP, REPO, expect.any(Function), { proposalId: "p1" });
    expect(autoSecurity).not.toHaveBeenCalled();
    await runProposalAction({ action: "github_bump_pr", resourceId: APP, targetRef: REPO, proposalId: "p2" }, "auto", deps({ bumpPrAs, autoSecurity }));
    expect(bumpPrAs).toHaveBeenLastCalledWith({ id: "office-auto", userId: null }, APP, REPO, expect.any(Function), { proposalId: "p2", auto: { severities: ["critical"] } });
    const off = vi.fn().mockResolvedValue({ enabled: false, severities: [], sameMajorOnly: true });
    bumpPrAs.mockClear();
    expect(await runProposalAction({ action: "github_bump_pr", resourceId: APP, targetRef: REPO }, "auto", deps({ bumpPrAs, autoSecurity: off }))).toMatchObject({ ok: false });
    expect(bumpPrAs).not.toHaveBeenCalled();
  });
});
