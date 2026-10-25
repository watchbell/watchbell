import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "@/db/schema";
import { AuthError } from "@/lib/action";
import { fakeDb, payloadOf } from "@/lib/data/fake-db";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const REF = "abcdefghijklmnopqrst";
const OTHER = "zyxwvutsrqponmlkjihg";
const THIRD = "qqqqqqqqqqqqqqqqqqqq";
const ACC = "223e4567-e89b-42d3-a456-426614174000";
const operator = { id: "mem-1", userId: "user-1", email: "op@example.com", role: "operator" as const };
const owner = { ...operator, role: "owner" as const };

const h = vi.hoisted(() => ({
  current: null as null | { db: () => unknown },
  requireActionMember: vi.fn(), limit: vi.fn(), refresh: vi.fn(), recordAction: vi.fn(), loadTarget: vi.fn(), setFlag: vi.fn(), accountPlans: vi.fn(),
}));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("next/cache", () => ({ refresh: h.refresh }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));
vi.mock("@/lib/data/provider-action-db", async (orig) => ({ ...(await orig<typeof import("@/lib/data/provider-action-db")>()), loadTarget: h.loadTarget }));
vi.mock("@/lib/data/keep-active-db", async (orig) => ({ ...(await orig<typeof import("@/lib/data/keep-active-db")>()), setFlag: h.setFlag, accountPlans: h.accountPlans }));

import { LIMITS } from "@/lib/rate-limit";
import { checkServicesAction, pauseAction, restoreAction, setAutoRestore, setKeepActive } from "./actions";

// MSW: an unexpected provider call fails the test (copied from lib/security/osv.test.ts).
const unmatched: string[] = [];
const posts: string[] = [];
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  server.resetHandlers();
  expect(unmatched.splice(0)).toEqual([]);
});
afterAll(() => server.close());
const catchAll = http.all("*", ({ request }) => {
  unmatched.push(`${request.method} ${request.url}`);
  return HttpResponse.error();
});
const API = "https://api.supabase.com";
const project = (ref: string, status: string, name = ref) => ({ id: ref, ref, organization_slug: "org-a", name, region: "ap-southeast-1", created_at: "2026-07-27T00:00:00Z", status });
const live = (status: string) => http.get(`${API}/v1/projects/${REF}`, () => HttpResponse.json(project(REF, status, "quillpad")));
const write = (verb: "pause" | "restore", res: () => Response = () => new HttpResponse(null, { status: 200 })) =>
  http.post(`${API}/v1/projects/${REF}/${verb}`, ({ request }) => { posts.push(`${request.method} ${new URL(request.url).pathname}`); return res(); });
const list = (...ps: ReturnType<typeof project>[]) => http.get(`${API}/v1/projects`, () => HttpResponse.json(ps));

const target = {
  resource: { id: UUID, externalId: REF, name: "quillpad", kind: "supabase_project" },
  account: { id: ACC, label: "utama", provider: "supabase", scopeNote: null },
  token: "sbp_fake_token_for_tests_000000000000",
};

let db: ReturnType<typeof fakeDb>;
beforeEach(() => {
  vi.resetAllMocks();
  posts.length = 0;
  db = fakeDb([]);
  h.current = db;
  h.requireActionMember.mockResolvedValue(operator);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.loadTarget.mockResolvedValue(target);
  h.recordAction.mockResolvedValue(undefined);
  h.accountPlans.mockResolvedValue(new Map([["org-a", true]]));
});

const access = () => db.writes.filter((w) => w.table === settings).map((w) => payloadOf(w.calls));

describe.each([
  ["pauseAction", pauseAction],
  ["restoreAction", restoreAction],
] as const)("%s guards", (_name, call) => {
  it("needs an operator: a viewer is refused before any limit, lookup or provider call", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    server.use(catchAll);
    expect(await call(UUID, REF)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("operator");
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.loadTarget).not.toHaveBeenCalled();
  });
  it("rejects a malformed id or ref before the limit", async () => {
    server.use(catchAll);
    for (const [id, ref] of [["nope", REF], [UUID, "../organizations"], [UUID, ""], [UUID, 42 as unknown as string]] as const) {
      expect(await call(id, ref)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    }
    expect(h.limit).not.toHaveBeenCalled();
  });
  it("uses the member quota, then the per-target cooldown (A4)", async () => {
    server.use(catchAll);
    h.limit.mockResolvedValueOnce({ allowed: true, retryAfter: 0 }).mockResolvedValueOnce({ allowed: false, retryAfter: 40 });
    expect(await call(UUID, REF)).toEqual({ ok: false, error: "That was just done. Wait a minute before trying again." });
    expect(h.limit.mock.calls.map((c) => c[0])).toEqual([LIMITS.providerAction, LIMITS.actionTarget]);
    expect(h.limit.mock.calls[1][1]).toMatch(new RegExp(`^(pause|restore):${UUID}$`));
    expect(h.loadTarget).not.toHaveBeenCalled();
  });
  it("refuses a stale dialog: the ref it showed is not this resource's ref (A3)", async () => {
    server.use(catchAll);
    expect(await call(UUID, OTHER)).toEqual({ ok: false, error: "This changed since you opened it. Reload and try again." });
    expect(posts).toEqual([]);
  });
  it("refuses an unknown resource or unreadable credential", async () => {
    server.use(catchAll);
    h.loadTarget.mockResolvedValue(null);
    expect(await call(UUID, REF)).toMatchObject({ ok: false });
    expect(h.loadTarget).toHaveBeenCalledWith(UUID, "supabase_project");
  });
});

describe("pauseAction", () => {
  it("pauses an active project, audits it and records the account's write access", async () => {
    server.use(live("ACTIVE_HEALTHY"), write("pause"), catchAll);
    expect(await pauseAction(UUID, REF)).toEqual({ ok: true, message: "Pausing quillpad. It takes about 2 minutes." });
    expect(posts).toEqual([`POST /v1/projects/${REF}/pause`]);
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "Pause requested · quillpad", resourceId: UUID, actorUserId: "user-1" });
    expect(access()).toEqual([expect.objectContaining({ key: `access.${ACC}`, value: expect.objectContaining({ write: "ok" }) })]);
    expect(h.refresh).toHaveBeenCalled();
  });
  it.each(["INACTIVE", "PAUSING"])("is a no-op when Supabase says %s: no POST, no audit", async (status) => {
    server.use(live(status), write("pause"), catchAll);
    expect(await pauseAction(UUID, REF)).toEqual({ ok: false, error: "Already paused." });
    expect(posts).toEqual([]);
    expect(h.recordAction).not.toHaveBeenCalled();
  });
  it("refuses while Supabase is busy with the project", async () => {
    server.use(live("RESTORING"), write("pause"), catchAll);
    expect(await pauseAction(UUID, REF)).toEqual({ ok: false, error: "Supabase is busy with this project (restoring). Try again in a few minutes." });
    expect(posts).toEqual([]);
  });
  it("a read-only token gets one sentence, flips access to denied and is audited as an error (A6)", async () => {
    server.use(live("ACTIVE_HEALTHY"), write("pause", () => HttpResponse.json({ message: "x", missing_permissions: ["project_admin_write"] }, { status: 403 })), catchAll);
    const r = await pauseAction(UUID, REF);
    expect(r).toEqual({ ok: false, error: "This token is read-only; replace it with one that has Project admin write." });
    expect(access()).toEqual([expect.objectContaining({ value: expect.objectContaining({ write: "denied" }) })]);
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "err", message: "Pause failed · quillpad", resourceId: UUID }));
    expect(JSON.stringify(h.recordAction.mock.calls)).not.toContain("missing_permissions");
  });
  it("a pause that timed out may still have happened: it says so and is audited as Pause requested (kind err) for the Auto-restore guard (M7)", async () => {
    server.use(live("ACTIVE_HEALTHY"), http.post(`${API}/v1/projects/${REF}/pause`, async () => { await new Promise((r) => setTimeout(r, 6_000)); return new HttpResponse(null, { status: 200 }); }), catchAll);
    const r = await pauseAction(UUID, REF);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("may still have happened") });
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "err", message: "Pause requested · quillpad", resourceId: UUID }));
    expect(access()).toEqual([]);
  }, 10_000);
  it("a provider error is audited with a short detail and leaves the write access alone", async () => {
    server.use(live("ACTIVE_HEALTHY"), write("pause", () => HttpResponse.json({ message: "boom" }, { status: 500 })), catchAll);
    expect(await pauseAction(UUID, REF)).toEqual({ ok: false, error: "Supabase returned an error (500)." });
    expect(h.recordAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "err", detail: "Supabase returned an error (500)." }));
    expect(access()).toEqual([]);
  });
});

describe("restoreAction", () => {
  it("restores a paused project when the account has a free slot", async () => {
    server.use(live("INACTIVE"), list(project(REF, "INACTIVE"), project(OTHER, "ACTIVE_HEALTHY")), write("restore"), catchAll);
    expect(await restoreAction(UUID, REF)).toEqual({ ok: true, message: "Restoring quillpad. It takes about 2 minutes." });
    expect(posts).toEqual([`POST /v1/projects/${REF}/restore`]);
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "Restore requested · quillpad", resourceId: UUID, actorUserId: "user-1" });
    expect(h.accountPlans).toHaveBeenCalledWith(ACC);
  });
  it("is blocked without a free slot, with the mockup's hint, and sends nothing (two steps: pause one first)", async () => {
    server.use(live("INACTIVE"), list(project(REF, "INACTIVE"), project(OTHER, "ACTIVE_HEALTHY"), project(THIRD, "ACTIVE_HEALTHY")), write("restore"), catchAll);
    const r = await restoreAction(UUID, REF);
    expect(r).toEqual({ ok: false, error: "This account already uses both free slots. Pause one of its active projects first; Restore stays blocked until it shows Paused." });
    expect(posts).toEqual([]);
    expect(h.recordAction).not.toHaveBeenCalled();
  });
  it("counts an unknown plan as free, and doesn't need a slot in a paid org", async () => {
    server.use(live("INACTIVE"), list(project(REF, "INACTIVE"), project(OTHER, "ACTIVE_HEALTHY"), project(THIRD, "ACTIVE_HEALTHY")), write("restore"), catchAll);
    h.accountPlans.mockResolvedValue(new Map([["org-a", null]]));
    expect((await restoreAction(UUID, REF)).ok).toBe(false);
    h.accountPlans.mockResolvedValue(new Map([["org-a", false]]));
    h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
    expect(await restoreAction(UUID, REF)).toMatchObject({ ok: true });
    expect(posts).toHaveLength(1);
  });
  it.each(["ACTIVE_HEALTHY", "RESTORING", "COMING_UP"])("is a no-op when Supabase says %s", async (status) => {
    server.use(live(status), write("restore"), catchAll);
    expect(await restoreAction(UUID, REF)).toEqual({ ok: false, error: "Already active or restoring." });
    expect(posts).toEqual([]);
  });
  it("passes on Supabase's refusal as a short sentence", async () => {
    server.use(live("INACTIVE"), list(project(REF, "INACTIVE")), write("restore", () => HttpResponse.json({ message: "limit" }, { status: 400 })), catchAll);
    expect(await restoreAction(UUID, REF)).toEqual({ ok: false, error: "Supabase returned an error (400)." });
  });
  it("any 403 on restore is the read-only sentence (A6)", async () => {
    server.use(live("INACTIVE"), list(project(REF, "INACTIVE")), write("restore", () => HttpResponse.json({ message: "Forbidden" }, { status: 403 })), catchAll);
    expect(await restoreAction(UUID, REF)).toEqual({ ok: false, error: "This token is read-only; replace it with one that has Project admin write." });
    expect(access()).toEqual([expect.objectContaining({ value: expect.objectContaining({ write: "denied" }) })]);
  });
});

describe.each([
  ["setKeepActive", setKeepActive, "keep"],
  ["setAutoRestore", setAutoRestore, "autoRestore"],
] as const)("%s (A2: owner only, console rows)", (_name, call, field) => {
  it("an operator is refused", async () => {
    h.requireActionMember.mockImplementation(async (min: string) => { if (min === "owner") throw new AuthError("forbidden"); return operator; });
    expect(await call(UUID, true)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.setFlag).not.toHaveBeenCalled();
  });
  it("the owner saves the flag, audited, with the console-row quota and no provider call", async () => {
    server.use(catchAll);
    h.requireActionMember.mockResolvedValue(owner);
    h.setFlag.mockResolvedValue({ ok: true, message: "Saved.", audit: { message: "x · quillpad", resourceId: UUID } });
    expect(await call(UUID, true)).toEqual({ ok: true, message: "Saved." });
    expect(h.setFlag).toHaveBeenCalledWith(UUID, field, true, "user-1");
    expect(h.limit).toHaveBeenCalledWith(LIMITS.monitorWrite, "mem-1");
    expect(h.recordAction).toHaveBeenCalledWith({ kind: "ok", message: "x · quillpad", resourceId: UUID, actorUserId: "user-1" });
  });
  it("rejects a malformed id or a non-boolean", async () => {
    h.requireActionMember.mockResolvedValue(owner);
    expect(await call("nope", true)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(await call(UUID, "yes" as unknown as boolean)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(h.setFlag).not.toHaveBeenCalled();
  });
});

// 1.2.1 (4c): Supabase → row menu → Check services: a read of the Management API's /health, no write, no audit.
describe("checkServicesAction", () => {
  const health = (body: object, status = 200) => http.get(`${API}/v1/projects/${REF}/health`, () => HttpResponse.json(body, { status }));

  it("reads the project's service health and answers with one sentence", async () => {
    server.use(health(["auth", "rest", "realtime", "storage", "db"].map((name) => ({ name, healthy: true, status: "ACTIVE_HEALTHY" }))), catchAll);
    expect(await checkServicesAction(UUID, REF)).toEqual({ ok: true, message: "All 5 services are healthy: Auth, REST, Realtime, Storage, Database." });
    expect(h.loadTarget).toHaveBeenCalledWith(UUID, "supabase_project");
    expect(h.recordAction).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
  });

  it("an unhealthy service is a failure toast that names it", async () => {
    server.use(health([{ name: "auth", healthy: true, status: "ACTIVE_HEALTHY" }, { name: "storage", healthy: false, status: "UNHEALTHY", error: "timeout" }]), catchAll);
    expect(await checkServicesAction(UUID, REF)).toEqual({ ok: false, error: "Not healthy: Storage (timeout). Healthy: Auth." });
  });

  it("needs an operator and valid ids; one check a minute per project", async () => {
    server.use(catchAll);
    expect(await checkServicesAction("nope", REF)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    h.limit.mockResolvedValueOnce({ allowed: false, retryAfter: 40 });
    expect(await checkServicesAction(UUID, REF)).toMatchObject({ ok: false });
    expect(h.limit.mock.calls[0]).toEqual([LIMITS.actionTarget, `check-services:${UUID}`]);
    expect(h.loadTarget).not.toHaveBeenCalled();
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await checkServicesAction(UUID, REF)).toEqual({ ok: false, error: "You don't have permission to do that." });
  });

  it("refuses a stale row and a gone project", async () => {
    server.use(catchAll);
    expect(await checkServicesAction(UUID, OTHER)).toEqual({ ok: false, error: "This changed since you opened it. Reload and try again." });
    h.loadTarget.mockResolvedValue(null);
    expect(await checkServicesAction(UUID, REF)).toMatchObject({ ok: false });
  });

  it("a failed read says so", async () => {
    server.use(health({ message: "boom" }, 500), catchAll);
    const r = await checkServicesAction(UUID, REF);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^Couldn't read the service health at Supabase: /);
  });
});
