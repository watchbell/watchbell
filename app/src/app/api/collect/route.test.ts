import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ after: vi.fn(), run: vi.fn(), last: vi.fn(), steps: [] as { name: string; run: ReturnType<typeof vi.fn> }[], core: [] as { name: string; run: ReturnType<typeof vi.fn> }[] }));
vi.mock("next/server", () => ({ after: h.after }));
vi.mock("@/lib/collector/env", () => ({ collectorEnv: () => ({ COLLECTOR_SECRET: "test-secret-not-real" }) }));
vi.mock("@/lib/collector/auth", () => ({ bearerOk: (header: string | null) => header === "Bearer test-secret-not-real" }));
vi.mock("@/lib/collector/run", () => ({ runCollector: h.run }));
vi.mock("@/lib/collector/last-run", () => ({ lastMinuteRunAt: h.last }));
vi.mock("@/lib/extensions", () => ({ extensions: { get minuteSteps() { return h.steps; } } }));
vi.mock("@/lib/collector/core-minute-steps", () => ({ CORE_MINUTE_STEPS: h.core }));

import { maxDuration, POST } from "./route";

const call = () => POST(new Request("https://watch.example.test/api/collect", { method: "POST", headers: { authorization: "Bearer test-secret-not-real" } }));

beforeEach(() => {
  vi.resetAllMocks();
  h.run.mockResolvedValue({ skipped: false, ok: true, tasks: ["checks"], checks: 3, durationMs: 1200, errors: [] });
  h.last.mockResolvedValue(new Date(Date.now() - 30 * 60_000));
  h.steps = [{ name: "office-meeting", run: vi.fn(async () => undefined) }, { name: "advisor-notes", run: vi.fn(async () => { throw new Error("x"); }) }];
});

describe("POST /api/collect: the minute steps after the response", () => {
  it("runs each minute step after the response with the run's deadline (request start + 60 s, less 5 s); a failing step is only a log line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const before = Date.now();
    const r = await call();
    const afterCall = Date.now();
    expect(r.status).toBe(200);
    expect(h.run).toHaveBeenCalledWith("cron_job_org");
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.steps[0].run).not.toHaveBeenCalled();
    await h.after.mock.calls[0][0]();
    const [now, ctx] = h.steps[0].run.mock.calls[0];
    expect(now).toBeInstanceOf(Date);
    expect(ctx.deadline).toBeGreaterThanOrEqual(before + maxDuration * 1000 - 5_000);
    expect(ctx.deadline).toBeLessThanOrEqual(afterCall + maxDuration * 1000 - 5_000);
    expect(h.steps[1].run).toHaveBeenCalledWith(now, ctx);
    expect(warn).toHaveBeenCalledWith("minute step advisor-notes failed");
    warn.mockRestore();
  });

  it("runs the core's own minute steps (Stage 12 Supabase compute) before the private ones", async () => {
    const order: string[] = [];
    h.core.splice(0, h.core.length, { name: "supabase-metrics", run: vi.fn(async () => { order.push("core"); }) });
    h.steps = [{ name: "office-meeting", run: vi.fn(async () => { order.push("ext"); }) }];
    await call();
    await h.after.mock.calls[0][0]();
    expect(order).toEqual(["core", "ext"]);
    h.core.splice(0, h.core.length);
  });

  it("refuses a request without the secret and runs nothing", async () => {
    const r = await POST(new Request("https://watch.example.test/api/collect", { method: "POST" }));
    expect(r.status).toBe(401);
    expect(h.run).not.toHaveBeenCalled();
    expect(h.after).not.toHaveBeenCalled();
  });
});

describe("POST /api/collect: a floor between scheduled runs (Vercel Hobby CPU, 28 Oct)", () => {
  it("answers a call within 10 minutes of the last run without running anything", async () => {
    h.last.mockResolvedValue(new Date(Date.now() - 60_000));
    const r = await call();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ skipped: true, reason: "The last run was less than 10 minutes ago." });
    expect(h.run).not.toHaveBeenCalled();
    expect(h.after).not.toHaveBeenCalled();
  });
  it("runs when there was no run yet", async () => {
    h.last.mockResolvedValue(null);
    await call();
    expect(h.run).toHaveBeenCalledOnce();
  });
  it("runs every call when WATCHBELL_COLLECT_MIN_GAP_MIN is 0, without asking for the last run", async () => {
    vi.stubEnv("WATCHBELL_COLLECT_MIN_GAP_MIN", "0");
    h.last.mockResolvedValue(new Date());
    await call();
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.last).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
