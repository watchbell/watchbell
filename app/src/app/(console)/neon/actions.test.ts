import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

// Provider calls go through the real Neon adapter against MSW; the catch-all turns any unexpected call into a failure.
const unmatched: string[] = [];
const server = setupServer(http.all("*", ({ request }) => { unmatched.push(`${request.method} ${request.url}`); return HttpResponse.error(); }));
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => { server.resetHandlers(); expect(unmatched.splice(0)).toEqual([]); });
afterAll(() => server.close());

const h = vi.hoisted(() => ({
  requireActionMember: vi.fn(),
  loadTarget: vi.fn(),
  targetQuota: vi.fn(),
  finish: vi.fn(),
  wakeScope: vi.fn(),
  readAliasBook: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/data/provider-action-db", () => ({ loadTarget: h.loadTarget, targetQuota: h.targetQuota, finish: h.finish }));
vi.mock("@/lib/data/neon-action-db", () => ({ wakeScope: h.wakeScope }));
vi.mock("@/lib/data/aliases-db", () => ({ readAliasBook: h.readAliasBook }));

import { STALE } from "@/lib/provider-actions";
import { wakeAction } from "./actions";

const API = "https://console.neon.tech/api/v2";
const PROJECT_RES = "123e4567-e89b-42d3-a456-426614174000";
const BRANCH_RES = "223e4567-e89b-42d3-a456-426614174000";
const ACCOUNT = "323e4567-e89b-42d3-a456-426614174000";
const EP = "ep-quiet-sun-a1b2c3";
const member = { id: "mem-1", userId: "user-1", email: "op@example.com", role: "operator" as const };
const target = {
  resource: { id: PROJECT_RES, kind: "neon_project", externalId: "ticketer-id", name: "ticketer" },
  account: { id: ACCOUNT, label: "utama", provider: "neon", scopeNote: null },
  token: "napi_fake_key_for_tests_0000000000000",
};
const scope = (extra: Record<string, unknown> = {}) => ({ projectResourceId: PROJECT_RES, branchExternalId: null, computeSeconds: 148_320, periodEnd: "2099-11-01T00:00:00Z", ...extra });
const endpoint = (extra: Record<string, unknown> = {}) => ({
  id: EP, branch_id: "br-main", current_state: "idle", disabled: false, autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 2, ...extra,
});

let posts = 0;
function neon(ep: Record<string, unknown> | number, start: number | "ok" = "ok") {
  server.use(
    http.get(`${API}/projects/ticketer-id/endpoints/${EP}`, () => (typeof ep === "number" ? HttpResponse.json({ message: "x" }, { status: ep }) : HttpResponse.json({ endpoint: ep }))),
    http.post(`${API}/projects/ticketer-id/endpoints/${EP}/start`, () => {
      posts++;
      return start === "ok" ? HttpResponse.json({ endpoint: endpoint({ current_state: "init" }), operations: [] }) : HttpResponse.json({ message: "provider body" }, { status: start });
    }),
  );
}

type Outcome = { message?: string; failed?: { error: string }; audit?: unknown };

beforeEach(() => {
  vi.resetAllMocks();
  posts = 0;
  h.requireActionMember.mockResolvedValue(member);
  h.targetQuota.mockResolvedValue(null);
  h.loadTarget.mockResolvedValue(target);
  h.wakeScope.mockResolvedValue(scope());
  h.readAliasBook.mockResolvedValue({ db: [{ id: PROJECT_RES, name: "ticketer", alias: "db-b" }], app: [] });
  // The runner's contract (Task 0): refusals answer ok:false with their message; written outcomes are audited.
  h.finish.mockImplementation(async (o: Outcome) =>
    (o.audit ? (o.failed ? { ok: false, error: o.failed.error } : { ok: true, message: o.message }) : { ok: false, error: o.message }));
});

describe("wakeAction", () => {
  it("needs an operator: a viewer is refused before any quota, load or provider call", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await wakeAction(PROJECT_RES, EP)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("operator");
    expect(h.targetQuota).not.toHaveBeenCalled();
    expect(h.loadTarget).not.toHaveBeenCalled();
    expect(posts).toBe(0);
  });

  it("validates both ids before anything else", async () => {
    const bad: [unknown, unknown][] = [["nope", EP], [PROJECT_RES, "ep-"], [PROJECT_RES, "br-main"], [PROJECT_RES, "ep-x/../start"], [PROJECT_RES, 7], [PROJECT_RES, `ep-${"a".repeat(61)}`], [PROJECT_RES, "EP-ABC-DEF"]];
    for (const [r, e] of bad) {
      expect(await wakeAction(r as string, e as string)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    }
    expect(h.targetQuota).not.toHaveBeenCalled();
    expect(h.wakeScope).not.toHaveBeenCalled();
  });

  it("stops at the quota (member or per-target cooldown) before loading anything", async () => {
    h.targetQuota.mockResolvedValue("That was just done. Wait a minute before trying again.");
    expect(await wakeAction(PROJECT_RES, EP)).toEqual({ ok: false, error: "That was just done. Wait a minute before trying again." });
    // The cooldown target is the compute, so two computes of one project don't share it (review fix).
    expect(h.targetQuota).toHaveBeenCalledWith("mem-1", "wake", EP);
    expect(h.wakeScope).not.toHaveBeenCalled();
    expect(h.loadTarget).not.toHaveBeenCalled();
  });

  it("answers STALE when the resource is unknown, gone or its credential can't be opened", async () => {
    h.wakeScope.mockResolvedValue(null);
    expect(await wakeAction(PROJECT_RES, EP)).toEqual({ ok: false, error: STALE });
    h.wakeScope.mockResolvedValue(scope());
    h.loadTarget.mockResolvedValue(null);
    expect(await wakeAction(PROJECT_RES, EP)).toEqual({ ok: false, error: STALE });
    expect(h.finish).not.toHaveBeenCalled();
  });

  it("resolves a watched branch to its project before loading the target", async () => {
    h.wakeScope.mockResolvedValue(scope({ branchExternalId: "br-main" }));
    neon(endpoint());
    expect(await wakeAction(BRANCH_RES, EP)).toMatchObject({ ok: true });
    expect(h.wakeScope).toHaveBeenCalledWith(BRANCH_RES);
    expect(h.loadTarget).toHaveBeenCalledWith(PROJECT_RES, "neon_project");
  });

  it("refuses a compute of another branch when a branch was watched (stale dialog)", async () => {
    h.wakeScope.mockResolvedValue(scope({ branchExternalId: "br-dev" }));
    neon(endpoint());
    expect(await wakeAction(BRANCH_RES, EP)).toEqual({ ok: false, error: STALE });
    expect(posts).toBe(0);
  });

  it("answers STALE when the endpoint isn't in the project's live list (404), with no write", async () => {
    neon(404);
    expect(await wakeAction(PROJECT_RES, EP)).toEqual({ ok: false, error: STALE });
    expect(posts).toBe(0);
    expect(h.finish.mock.calls[0]?.[0]).not.toHaveProperty("audit");
  });

  it("is a no-op when the compute already runs: 'Already running.' and 0 POSTs", async () => {
    neon(endpoint({ current_state: "active" }));
    expect(await wakeAction(PROJECT_RES, EP)).toEqual({ ok: false, error: "Already running." });
    expect(posts).toBe(0);
  });

  it("is a no-op while the compute is already starting", async () => {
    neon(endpoint({ current_state: "init" }));
    expect(await wakeAction(PROJECT_RES, EP)).toEqual({ ok: false, error: "Already starting." });
    neon(endpoint({ current_state: "idle", pending_state: "active" }));
    expect(await wakeAction(PROJECT_RES, EP)).toEqual({ ok: false, error: "Already starting." });
    expect(posts).toBe(0);
  });

  it("refuses a compute Neon disabled, with no write", async () => {
    neon(endpoint({ disabled: true }));
    expect(await wakeAction(PROJECT_RES, EP)).toEqual({ ok: false, error: "Neon has disabled this compute, so it can't be started from here." });
    expect(posts).toBe(0);
  });

  it("refuses from the snapshot when this month's 100 CU-hours are used, without calling Neon", async () => {
    h.wakeScope.mockResolvedValue(scope({ computeSeconds: 100 * 3600 }));
    expect(await wakeAction(PROJECT_RES, EP)).toEqual({ ok: false, error: "This project used its 100 CU-hours; the compute won't start until the quota resets." });
    h.wakeScope.mockResolvedValue(scope({ computeSeconds: 100 * 3600 + 1, periodEnd: null }));
    expect(await wakeAction(PROJECT_RES, EP)).toEqual({ ok: false, error: "This project used its 100 CU-hours; the compute won't start until the quota resets." });
  });

  it("doesn't refuse on last period's CU-hours once the period has ended", async () => {
    h.wakeScope.mockResolvedValue(scope({ computeSeconds: 100 * 3600, periodEnd: "2020-01-01T00:00:00Z" }));
    neon(endpoint());
    expect(await wakeAction(PROJECT_RES, EP)).toMatchObject({ ok: true });
    expect(posts).toBe(1);
  });

  it("passes a failed live read on without writing or auditing", async () => {
    neon(500);
    expect(await wakeAction(PROJECT_RES, EP)).toEqual({ ok: false, error: "Neon returned an error (500)." });
    expect(posts).toBe(0);
    expect(h.finish.mock.calls[0]?.[0]).not.toHaveProperty("audit");
  });

  it("starts an idle compute once and audits 'Wake requested · {endpoint}'", async () => {
    neon(endpoint());
    expect(await wakeAction(PROJECT_RES, EP)).toEqual({ ok: true, message: `Waking ${EP}. Ready in a few seconds.` });
    expect(posts).toBe(1);
    expect(h.finish).toHaveBeenCalledWith(
      { done: true, message: `Waking ${EP}. Ready in a few seconds.`, audit: { message: `Wake requested · ${EP}`, resourceId: PROJECT_RES } },
      member, ACCOUNT,
    );
  });

  it("maps 423 to the transient busy sentence and audits the failed attempt", async () => {
    neon(endpoint(), 423);
    const busy = "Neon is busy with another operation. Try again in a minute.";
    expect(await wakeAction(PROJECT_RES, EP)).toEqual({ ok: false, error: busy });
    expect(h.finish.mock.calls[0][0]).toEqual({ done: false, failed: { ok: false, kind: "busy", status: 423, error: busy }, audit: { message: `Wake failed · ${EP}`, resourceId: PROJECT_RES } });
  });

  it("maps 403 to the A6 sentence naming the project (scope, so the runner marks access denied)", async () => {
    neon(endpoint(), 403);
    const msg = "This API key can't manage project ticketer; replace it with a personal or organization key, or a key for this project.";
    // Privacy: the toast names the database by its alias; the audit keeps the real name (events are masked on display).
    expect(await wakeAction(PROJECT_RES, EP)).toEqual({ ok: false, error: msg.replace("ticketer", "db-b") });
    expect(h.finish.mock.calls[0][0]).toMatchObject({ failed: { kind: "scope", error: msg } });
    expect(JSON.stringify(h.finish.mock.calls[0][0])).not.toContain("provider body");
  });

  it("never puts the real project name in a toast, even when the alias letters can't be read", async () => {
    neon(endpoint(), 403);
    h.readAliasBook.mockRejectedValue(new Error("db down"));
    const r = await wakeAction(PROJECT_RES, EP);
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain("ticketer");
  });

  it("passes a 401 on the write on as a rejected credential", async () => {
    neon(endpoint(), 401);
    expect(await wakeAction(PROJECT_RES, EP)).toEqual({ ok: false, error: "Neon rejected this credential (401)." });
    expect(h.finish.mock.calls[0][0]).toMatchObject({ failed: { kind: "auth" }, audit: { message: `Wake failed · ${EP}` } });
  });

  it("treats a 404 on the write (compute removed in between) as stale", async () => {
    neon(endpoint(), 404);
    expect(await wakeAction(PROJECT_RES, EP)).toEqual({ ok: false, error: STALE });
  });
});
