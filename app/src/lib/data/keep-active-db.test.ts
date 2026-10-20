import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { keepActive } from "@/db/schema";
import { fakeDb, payloadOf } from "@/lib/data/fake-db";

const h = vi.hoisted(() => ({
  current: null as null | { db: () => unknown },
  recordEvents: vi.fn(), writeAccess: vi.fn(), setWriteAccess: vi.fn(), openOrNull: vi.fn(),
}));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: "k" }) }));
vi.mock("@/lib/crypto", () => ({ openOrNull: h.openOrNull }));
vi.mock("@/lib/data/events-write", () => ({ recordEvents: h.recordEvents }));
vi.mock("@/lib/data/provider-action-db", () => ({ writeAccess: h.writeAccess, setWriteAccess: h.setWriteAccess }));

import { autoRestoreHook, runKeepAlive, setFlag, slotsLeft } from "./keep-active-db";

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
const REF = "abcdefghijklmnopqrst";
const DAY = 86_400_000;
const now = new Date("2026-10-13T20:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const ok = (path: string, res: () => Response = () => HttpResponse.json([{ ok: 1 }])) =>
  http.post(`${API}${path}`, ({ request }) => { posts.push(new URL(request.url).pathname); return res(); });

beforeEach(() => {
  vi.resetAllMocks();
  posts.length = 0;
  h.openOrNull.mockReturnValue("sbp_fake");
  h.recordEvents.mockResolvedValue(undefined);
  h.writeAccess.mockResolvedValue(new Map());
  h.setWriteAccess.mockResolvedValue(undefined);
});

const events = () => h.recordEvents.mock.calls.flatMap((c) => c[0] as Record<string, unknown>[]);

describe("slotsLeft", () => {
  it("counts free-org projects that use a slot; an unknown plan counts as free; a paid org needs none", () => {
    const ps = [{ status: "ACTIVE_HEALTHY", orgSlug: "a" }, { status: "INACTIVE", orgSlug: "a" }, { status: "COMING_UP", orgSlug: "b" }];
    expect(slotsLeft(ps, new Map([["a", true], ["b", true]]), "a")).toBe(0);
    expect(slotsLeft(ps, new Map([["a", true], ["b", false]]), "a")).toBe(1);
    expect(slotsLeft(ps, new Map(), "a")).toBe(0);
    expect(slotsLeft(ps, new Map([["a", false]]), "a")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("setFlag", () => {
  it("upserts one field for a watched Supabase project, with who and when", async () => {
    const f = fakeDb([[{ id: "r1", name: "quillpad" }]]);
    h.current = f;
    const r = await setFlag("r1", "autoRestore", true, "user-1");
    expect(r).toEqual({ ok: true, message: "quillpad is restored automatically when its account has a free slot.", audit: { message: "Auto-restore on · quillpad", resourceId: "r1" } });
    expect(payloadOf(f.writes[0].calls)).toEqual(expect.objectContaining({ resourceId: "r1", autoRestore: true, updatedBy: "user-1" }));
  });
  it("refuses a project that isn't watched", async () => {
    h.current = fakeDb([[]]);
    expect(await setFlag("r1", "keep", true, "user-1")).toEqual({ ok: false, error: "That Supabase project is no longer watched." });
  });
});

const keptRow = (data: Record<string, unknown>, k: Record<string, unknown> = {}) => ({
  k: { resourceId: "r1", keep: true, autoRestore: false, lastKeepAliveAt: null, lastAutoRestoreAt: null, updatedBy: null, updatedAt: ago(30 * DAY), ...k },
  r: { id: "r1", name: "quillpad", externalId: REF, firstSeenAt: ago(60 * DAY) },
  s: { data },
  a: { label: "utama", credentialCiphertext: "c", credentialIv: "i" },
});

describe("runKeepAlive (daily step)", () => {
  it("sends one select 1 to a kept project idle for 5 days, stamps it and leaves a system event", async () => {
    const f = fakeDb([[keptRow({ status: "ACTIVE_HEALTHY", lastTrafficAt: ago(5 * DAY).toISOString(), trafficAt: now.toISOString() })]]);
    h.current = f;
    server.use(ok(`/v1/projects/${REF}/database/query/read-only`), catchAll);
    const errors: string[] = [];
    await runKeepAlive(now, Date.now() + 5_000, errors);
    expect(errors).toEqual([]);
    expect(posts).toEqual([`/v1/projects/${REF}/database/query/read-only`]);
    expect(f.writes.map((w) => [w.table, payloadOf(w.calls)])).toEqual([[keepActive, { lastKeepAliveAt: now }]]);
    expect(events()).toEqual([expect.objectContaining({ type: "action", kind: "ok", actorUserId: null, resourceId: "r1", message: "Keep-alive: sent to quillpad (no API traffic for 5 days)" })]);
  });
  it("skips a project with recent traffic, a non-active one, and one already kept alive today", async () => {
    h.current = fakeDb([[
      keptRow({ status: "ACTIVE_HEALTHY", lastTrafficAt: ago(2 * DAY).toISOString() }),
      keptRow({ status: "INACTIVE" }),
      keptRow({ status: "ACTIVE_HEALTHY", lastTrafficAt: ago(9 * DAY).toISOString() }, { lastKeepAliveAt: ago(3600_000) }),
    ]]);
    server.use(catchAll);
    const errors: string[] = [];
    await runKeepAlive(now, Date.now() + 5_000, errors);
    expect(posts).toEqual([]);
    expect(events()).toEqual([]);
  });
  it("a failed keep-alive raises a repeatable warning and never throws", async () => {
    h.current = fakeDb([[keptRow({ status: "ACTIVE_HEALTHY", lastTrafficAt: ago(5 * DAY).toISOString() })]]);
    server.use(ok(`/v1/projects/${REF}/database/query/read-only`, () => HttpResponse.json({ message: "x" }, { status: 500 })), catchAll);
    const errors: string[] = [];
    await runKeepAlive(now, Date.now() + 5_000, errors);
    expect(events()).toEqual([expect.objectContaining({ kind: "warn", reason: "KeepAliveFailed", actorUserId: null, message: "Keep-alive failed for quillpad; it may pause in about 2 days" })]);
    expect(errors).toEqual(["keep-active/quillpad: Supabase returned an error (500)."]);
  });
  it("a database failure is one short line, not a throw", async () => {
    h.current = fakeDb([new Error("connection reset")]);
    const errors: string[] = [];
    await expect(runKeepAlive(now, Date.now() + 5_000, errors)).resolves.toBeUndefined();
    expect(errors).toEqual(["keep-active: Error"]);
  });
  it("a database error on one project is one line, and the next project still gets its keep-alive (M9)", async () => {
    const REF2 = "bbbbbbbbbbbbbbbbbbbb";
    const second = { ...keptRow({ status: "ACTIVE_HEALTHY", lastTrafficAt: ago(6 * DAY).toISOString() }), r: { id: "r2", name: "ticketer", externalId: REF2, firstSeenAt: ago(60 * DAY) } };
    // The first project's stamp fails (the write queue's first answer); the second one's works.
    h.current = fakeDb([[keptRow({ status: "ACTIVE_HEALTHY", lastTrafficAt: ago(5 * DAY).toISOString() }), second]], [new Error("connection reset"), []]);
    server.use(ok(`/v1/projects/${REF}/database/query/read-only`), ok(`/v1/projects/${REF2}/database/query/read-only`), catchAll);
    const errors: string[] = [];
    await runKeepAlive(now, Date.now() + 5_000, errors);
    expect(posts).toEqual([`/v1/projects/${REF}/database/query/read-only`, `/v1/projects/${REF2}/database/query/read-only`]);
    expect(errors).toEqual(["keep-active/quillpad: Error"]);
    expect(events()).toEqual([expect.objectContaining({ resourceId: "r2", message: "Keep-alive: sent to ticketer (no API traffic for 6 days)" })]);
  });
  it("starts nothing once the time is up", async () => {
    h.current = fakeDb([[keptRow({ status: "ACTIVE_HEALTHY", lastTrafficAt: ago(9 * DAY).toISOString() })]]);
    server.use(catchAll);
    const errors: string[] = [];
    await runKeepAlive(now, Date.now() - 1, errors);
    expect(posts).toEqual([]);
    expect(errors).toEqual(["keep-active: 1 left for the next run, time budget used"]);
  });
});

const ACC = "acc1";
const restoreRow = (k: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  k: { resourceId: "r1", keep: false, autoRestore: true, lastKeepAliveAt: null, lastAutoRestoreAt: null, updatedBy: null, updatedAt: ago(30 * DAY), ...k },
  id: "r1", name: "quillpad", ref: REF, accountId: ACC, label: "utama", lastTestAt: ago(40 * DAY), ciphertext: "c", iv: "i", ...extra,
});
const plans = [{ data: { orgSlug: "org-a", freeOrg: true } }];
const st = (resourceId: string | null, status: string) => ({ resourceId, accountId: ACC, status, orgSlug: "org-a" });

describe("autoRestoreHook (status task)", () => {
  it("reads nothing when no watched project is paused", async () => {
    const f = fakeDb([]);
    h.current = f;
    await autoRestoreHook(now, [st("r1", "ACTIVE_HEALTHY"), st(null, "INACTIVE")]);
    expect(f.queries).toEqual([]);
  });
  it("restores a paused project with Auto-restore on when the account has a free slot, stamping the attempt first", async () => {
    const f = fakeDb([[restoreRow()], plans]);
    h.current = f;
    server.use(ok(`/v1/projects/${REF}/restore`), catchAll);
    await autoRestoreHook(now, [st("r1", "INACTIVE"), st(null, "ACTIVE_HEALTHY")]);
    expect(posts).toEqual([`/v1/projects/${REF}/restore`]);
    expect(f.writes.map((w) => payloadOf(w.calls))).toEqual([{ lastAutoRestoreAt: now }]);
    expect(h.setWriteAccess).toHaveBeenCalledWith(ACC, "ok");
    expect(events()).toEqual([expect.objectContaining({ type: "action", kind: "ok", actorUserId: null, message: "Auto-restore: restoring quillpad" })]);
  });
  it("waits without a free slot, never pausing anything (a repeatable event, no POST)", async () => {
    h.current = fakeDb([[restoreRow()], plans]);
    server.use(catchAll);
    await autoRestoreHook(now, [st("r1", "INACTIVE"), st(null, "ACTIVE_HEALTHY"), st("r2", "ACTIVE_HEALTHY")]);
    expect(posts).toEqual([]);
    expect(events()).toEqual([expect.objectContaining({ reason: "AutoRestoreWaits", actorUserId: null, message: "Auto-restore: quillpad waits, account utama has no free slot" })]);
  });
  it("tries at most once per 6 hours", async () => {
    h.current = fakeDb([[restoreRow({ lastAutoRestoreAt: ago(5 * 3600_000) })], plans]);
    server.use(catchAll);
    await autoRestoreHook(now, [st("r1", "INACTIVE")]);
    expect(posts).toEqual([]);
    expect(events()).toEqual([]);
  });
  it("one free slot restores only one of two paused projects", async () => {
    h.current = fakeDb([[restoreRow(), restoreRow({ resourceId: "r2" }, { id: "r2", name: "web", ref: "bbbbbbbbbbbbbbbbbbbb" })], plans]);
    server.use(ok(`/v1/projects/${REF}/restore`), catchAll);
    await autoRestoreHook(now, [st("r1", "INACTIVE"), st("r2", "INACTIVE"), st(null, "ACTIVE_HEALTHY")]);
    expect(posts).toEqual([`/v1/projects/${REF}/restore`]);
    expect(events().map((e) => e.message)).toEqual(["Auto-restore: restoring quillpad", "Auto-restore: web waits, account utama has no free slot"]);
  });
  it("a 403 sets the account's access to denied, and later runs stop until the owner re-ticks or replaces the token", async () => {
    h.current = fakeDb([[restoreRow()], plans]);
    server.use(ok(`/v1/projects/${REF}/restore`, () => HttpResponse.json({ message: "Forbidden" }, { status: 403 })), catchAll);
    await autoRestoreHook(now, [st("r1", "INACTIVE")]);
    expect(h.setWriteAccess).toHaveBeenCalledWith(ACC, "denied");
    expect(events()).toEqual([expect.objectContaining({ kind: "err", message: "Auto-restore: quillpad couldn't be restored", detail: "This token is read-only; replace it with one that has Project admin write. Auto-restore stops until then." })]);

    // 7 hours later: denied after the last tick and the last credential test → no attempt.
    h.recordEvents.mockClear();
    posts.length = 0;
    h.writeAccess.mockResolvedValue(new Map([[ACC, { write: "denied", at: now.toISOString() }]]));
    const later = new Date(now.getTime() + 7 * 3600_000);
    h.current = fakeDb([[restoreRow({ lastAutoRestoreAt: now })], plans]);
    await autoRestoreHook(later, [st("r1", "INACTIVE")]);
    expect(posts).toEqual([]);
    // The owner ticks the box again after the denial: it tries again.
    h.current = fakeDb([[restoreRow({ lastAutoRestoreAt: now, updatedAt: new Date(now.getTime() + 3600_000) })], plans]);
    server.use(ok(`/v1/projects/${REF}/restore`));
    await autoRestoreHook(later, [st("r1", "INACTIVE")]);
    expect(posts).toEqual([`/v1/projects/${REF}/restore`]);
  });
  it("a paid-org project doesn't lend its unlimited slots to a free-org project of the same account (A8)", async () => {
    const paidRef = "pppppppppppppppppppp";
    h.current = fakeDb([[
      restoreRow({ resourceId: "rp" }, { id: "rp", name: "paid-db", ref: paidRef }),
      restoreRow(),
    ], [{ data: { orgSlug: "org-a", freeOrg: true } }, { data: { orgSlug: "org-p", freeOrg: false } }]]);
    server.use(ok(`/v1/projects/${paidRef}/restore`), catchAll);
    await autoRestoreHook(now, [
      { ...st("rp", "INACTIVE"), orgSlug: "org-p" }, st("r1", "INACTIVE"),
      st(null, "ACTIVE_HEALTHY"), st(null, "ACTIVE_HEALTHY"),
    ]);
    expect(posts).toEqual([`/v1/projects/${paidRef}/restore`]);
    expect(events().map((e) => e.message)).toEqual(["Auto-restore: restoring paid-db", "Auto-restore: quillpad waits, account utama has no free slot"]);
  });
  it("doesn't undo a pause a member asked for through the console after the box was last ticked (can't fight the owner)", async () => {
    // Pause-first flow: the member pauses quillpad to free a slot for another project. Auto-restore must not take
    // that slot back 5 minutes later.
    const f = fakeDb([[restoreRow()], plans, [{ at: ago(10 * 60_000) }]]);
    h.current = f;
    server.use(catchAll);
    await autoRestoreHook(now, [st("r1", "INACTIVE"), st(null, "ACTIVE_HEALTHY")]);
    expect(posts).toEqual([]);
    expect(f.writes).toEqual([]);
    expect(events()).toEqual([]);
    // The owner ticks the box again after that pause: Auto-restore is armed again.
    h.current = fakeDb([[restoreRow({ updatedAt: ago(60_000) })], plans, [{ at: ago(10 * 60_000) }]]);
    server.use(ok(`/v1/projects/${REF}/restore`));
    await autoRestoreHook(now, [st("r1", "INACTIVE"), st(null, "ACTIVE_HEALTHY")]);
    expect(posts).toEqual([`/v1/projects/${REF}/restore`]);
  });
  it("starts nothing once the status task's time is up: no read, no stamp, no POST", async () => {
    const f = fakeDb([[restoreRow()], plans]);
    h.current = f;
    server.use(catchAll);
    await autoRestoreHook(now, [st("r1", "INACTIVE")], Date.now() + 100);
    expect(posts).toEqual([]);
    expect(f.writes).toEqual([]);
    expect(f.queries).toEqual([]);
  });
  it("cuts the restore call's timeout to the time the status task has left", async () => {
    h.current = fakeDb([[restoreRow()], plans]);
    server.use(http.post(`${API}/v1/projects/${REF}/restore`, async () => {
      await new Promise((r) => setTimeout(r, 3_000));
      return HttpResponse.json({});
    }), catchAll);
    const t0 = Date.now();
    await autoRestoreHook(now, [st("r1", "INACTIVE")], Date.now() + 1_500);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(events()).toEqual([expect.objectContaining({ kind: "err", message: "Auto-restore: quillpad couldn't be restored" })]);
  });
});

// Stage 6 minor M7: a console Pause whose call timed out may still have happened. It is audited as
// "Pause requested · {name}" with kind err, and the "a member paused it" guard counts it like an ok one.
describe("the console-pause guard counts a pause that may have happened (M7)", () => {
  it("looks for Pause requested rows of kind ok or err, by a member", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const f = fakeDb([[restoreRow()], plans, [{ at: ago(10 * 60_000) }]]);
    h.current = f;
    server.use(catchAll);
    await autoRestoreHook(now, [st("r1", "INACTIVE"), st(null, "ACTIVE_HEALTHY")]);
    expect(posts).toEqual([]);
    const q = new PgDialect().sqlToQuery(f.queries[2].find((c) => c.method === "where")?.args[0] as never);
    expect(q.sql).toMatch(/"kind" in \(\$\d+, \$\d+\)/);
    expect(q.params).toEqual(expect.arrayContaining(["ok", "err", "Pause requested · %"]));
  });
});
