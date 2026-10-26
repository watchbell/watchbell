import { PGlite } from "@electric-sql/pglite";
import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { alerts, checks, collectorRuns, events, monitors } from "@/db/schema";

// Review Focus 3: in demo, anything that would reach a provider answers "Not available in the demo" without a single
// outbound request, and the harmless actions (Check now, Refresh now, alert changes) write a simulated result to the
// visitor's own database. The server actions run for real here; only the sign-in check, Next's cache calls and db()
// (the seeded PGlite) are stood in for.
const h = vi.hoisted(() => ({ db: undefined as unknown, member: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));
vi.mock("@/lib/auth", () => ({ requireActionMember: async () => h.member }));
// after() needs a request scope; here its callback just runs.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: (fn: () => unknown) => void fn() }));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn(), revalidatePath: vi.fn(), unstable_cache: (fn: unknown) => fn }));

import { AuthError, runGuarded } from "@/lib/action";
import { guardedFetch } from "@/lib/demo/fetch-guard";
import { sendDiscord } from "@/lib/notify/discord";
import { sendEmail } from "@/lib/notify/resend";
import { sendTelegram } from "@/lib/notify/telegram";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { DEMO_BUSY, DEMO_TOO_MANY, demoNoticeError } from "./notices";
import { DEMO_UNAVAILABLE, DemoUnavailable, demoRouteGone, demoRouteRefused, isDemoRefusal, simulatedCheck } from "./simulate";
import { demoUserId, seedDemoDb } from "./seed";
import { memberRowId } from "./seed/members";

const SAVED = process.env.WATCHPOST_MODE;
const restoreMode = () => {
  if (SAVED === undefined) delete process.env.WATCHPOST_MODE;
  else process.env.WATCHPOST_MODE = SAVED;
};
const ok = async () => ({ ok: true as const, message: "ran" });
const member = { id: "m1", userId: "u1", email: "owner@example.com", role: "owner" as const };
const deps = { requireActionMember: async () => member };

describe("runGuarded in demo (fail-closed)", () => {
  afterEach(restoreMode);

  it("refuses an action that doesn't declare itself demo-safe, before it runs", async () => {
    process.env.WATCHPOST_MODE = "demo";
    const fn = vi.fn(ok);
    expect(await runGuarded("operator", fn, deps)).toEqual({ ok: false, error: DEMO_UNAVAILABLE });
    expect(fn).not.toHaveBeenCalled();
  });

  it("runs a \"local\" action as usual and a simulated one instead of the real one", async () => {
    process.env.WATCHPOST_MODE = "demo";
    expect(await runGuarded("operator", ok, deps, "local")).toEqual({ ok: true, message: "ran" });
    const real = vi.fn(ok);
    expect(await runGuarded("operator", real, deps, async (m) => ({ ok: true, message: `simulated for ${m.email}` }))).toEqual({ ok: true, message: "simulated for owner@example.com" });
    expect(real).not.toHaveBeenCalled();
  });

  it("still checks the sign-in first", async () => {
    process.env.WATCHPOST_MODE = "demo";
    const r = await runGuarded("owner", ok, { requireActionMember: async () => { throw new AuthError("forbidden"); } }, "local");
    expect(r).toEqual({ ok: false, error: "You don't have permission to do that." });
  });

  it("turns the fetch guard's refusal into the demo message", async () => {
    process.env.WATCHPOST_MODE = "demo";
    const blocked = guardedFetch(vi.fn());
    const r = await runGuarded("operator", async () => {
      await blocked("https://api.vercel.com/v13/deployments");
      return { ok: true };
    }, deps, "local");
    expect(r).toEqual({ ok: false, error: DEMO_UNAVAILABLE });
  });

  it("passes the pool's notices (busy, too many new sessions) through as themselves, also wrapped by Drizzle", async () => {
    process.env.WATCHPOST_MODE = "demo";
    for (const notice of [DEMO_BUSY, DEMO_TOO_MANY] as const) {
      const thrown = demoNoticeError(notice);
      expect(await runGuarded("operator", async () => { throw thrown; }, deps, "local")).toEqual({ ok: false, error: notice });
      const wrapped = new DrizzleQueryError("select 1", [], thrown);
      expect(await runGuarded("operator", async () => { throw wrapped; }, { requireActionMember: async () => { throw wrapped; } })).toEqual({ ok: false, error: notice });
    }
    // The same text without the notice's digest is just an error.
    expect(await runGuarded("operator", async () => { throw new Error(DEMO_BUSY); }, deps, "local")).toEqual({ ok: false, error: "That didn't go through, and Watchbell couldn't tell why. Try again in a moment; if it keeps failing, the server log has the details." });
  });

  it("changes nothing in cloud and self-host", async () => {
    for (const m of [undefined, "selfhost"]) {
      if (m) process.env.WATCHPOST_MODE = m;
      else delete process.env.WATCHPOST_MODE;
      expect(await runGuarded("operator", ok, deps)).toEqual({ ok: true, message: "ran" });
      expect(await runGuarded("operator", ok, deps, async () => ({ ok: false, error: "never" }))).toEqual({ ok: true, message: "ran" });
      expect(await runGuarded("operator", async () => { throw new Error(DEMO_UNAVAILABLE); }, deps)).toEqual({ ok: false, error: "That didn't go through, and Watchbell couldn't tell why. Try again in a moment; if it keeps failing, the server log has the details." });
      expect(await runGuarded("operator", async () => { throw demoNoticeError(DEMO_BUSY); }, deps)).toEqual({ ok: false, error: "That didn't go through, and Watchbell couldn't tell why. Try again in a moment; if it keeps failing, the server log has the details." });
    }
  });
});

describe("demo helpers", () => {
  it("knows a demo refusal only in demo", () => {
    const e = new Error(DEMO_UNAVAILABLE);
    expect(isDemoRefusal(e, { WATCHPOST_MODE: "demo" })).toBe(true);
    expect(isDemoRefusal(e, {})).toBe(false);
    expect(isDemoRefusal(new Error("other"), { WATCHPOST_MODE: "demo" })).toBe(false);
  });

  it("answers 404 for the scheduler and webhook routes in demo only", async () => {
    expect(demoRouteGone({ WATCHPOST_MODE: "demo" })?.status).toBe(404);
    expect(demoRouteGone({})).toBeNull();
    expect(demoRouteGone({ WATCHPOST_MODE: "selfhost" })).toBeNull();
  });

  it("refuses the signed-in routes the demo doesn't run with 403 and the one message, in demo only", async () => {
    const r = demoRouteRefused({ WATCHPOST_MODE: "demo" })!;
    expect(r.status).toBe(403);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ error: DEMO_UNAVAILABLE });
    expect(demoRouteRefused({})).toBeNull();
    expect(demoRouteRefused({ WATCHPOST_MODE: "selfhost" })).toBeNull();
  });

  it("one refusal message everywhere: the fetch guard throws DemoUnavailable with it", () => {
    expect(new DemoUnavailable().message).toBe(DEMO_UNAVAILABLE);
    expect(DEMO_UNAVAILABLE).toBe("Not available in the demo");
  });

  it("makes up a passing check", () => {
    expect(simulatedCheck(200, () => 0.5)).toEqual({ ok: true, statusCode: 200, latencyMs: 220, error: null });
  });
});

describe("in demo nothing leaves the server", () => {
  const fetchSpy = vi.fn(async () => new Response("{}"));
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.WATCHPOST_MODE = "demo";
    fetchSpy.mockClear();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    h.member = member;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    restoreMode();
  });

  it("the scheduler and webhook routes answer 404 before doing anything", async () => {
    const post = (path: string) => new Request(`https://demo.example${path}`, { method: "POST", headers: { authorization: "Bearer x" } });
    const [collect, daily, watchdog, telegram] = await Promise.all([
      import("@/app/api/collect/route"), import("@/app/api/daily/route"), import("@/app/api/watchdog/route"), import("@/app/api/telegram/webhook/route"),
    ]);
    expect((await collect.POST(post("/api/collect"))).status).toBe(404);
    expect((await daily.GET(new Request("https://demo.example/api/daily"))).status).toBe(404);
    expect((await watchdog.POST(post("/api/watchdog"))).status).toBe(404);
    expect((await telegram.POST(post("/api/telegram/webhook"))).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 90_000); // four cold route imports inside the test: 4-14 s on a busy machine, and over 30 s in a loaded full run (26 Oct)

  // The private edition's extra routes test their demo refusals on their own side.
  it("/api/status refuses before reading the session", async () => {
    const status = await import("@/app/api/status/route");
    h.member = undefined; // no session read: a refusal never gets that far
    const res = await status.GET();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: DEMO_UNAVAILABLE });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Telegram, Discord and Resend senders send nothing", async () => {
    expect(await sendTelegram("123:abc", "42", "hi")).toMatchObject({ ok: false, error: DEMO_UNAVAILABLE });
    expect(await sendDiscord("https://discord.com/api/web" + "hooks/12345/abcdefghijklmnopqrstuvwxyz", "hi")).toEqual({ ok: false, kind: "config", error: DEMO_UNAVAILABLE });
    expect(await sendEmail("re_x", { from: "a@example.com", to: "b@example.com", subject: "s", html: "h", text: "t", idempotencyKey: "k" })).toEqual({ ok: false, kind: "config", error: DEMO_UNAVAILABLE });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("every action that would reach a provider says so and makes no request", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const dpl = "dpl_ABCDEFGHIJKLMNOPQRSTUVWX";
    const form = new FormData();
    form.set("email", "new@example.com");
    form.set("role", "viewer");
    const [vercel, supa, neon, dns, domains, sync, conns, channels, approvals, deps_, security, github, backups, sqlA, logs, settingsA, create, metrics, ghSync] = await Promise.all([
      import("@/app/(console)/vercel-actions"), import("@/app/(console)/supabase/actions"), import("@/app/(console)/neon/actions"), import("@/app/(console)/dns/actions"),
      import("@/app/(console)/domains/actions"), import("@/app/(console)/connections/sync-actions"), import("@/app/(console)/connections/actions"),
      import("@/app/(console)/alerts/channel-actions"), import("@/app/(console)/alerts/telegram-approvals-actions"), import("@/app/(console)/apps/[id]/deps-actions"),
      import("@/app/(console)/apps/[id]/security-actions"), import("@/app/(console)/apps/[id]/github-actions"), import("@/app/(console)/backups/actions"),
      import("@/app/(console)/sql/actions"), import("@/app/(console)/logs/actions"), import("@/app/(console)/settings/actions"), import("@/app/(console)/create/actions"),
      import("@/app/(console)/supabase/metrics-actions"), import("@/app/(console)/connections/github-actions"),
    ]);
    const rec = { type: "A", name: "x.example", content: "192.0.2.1", proxied: false, ttl: 300 };
    const calls: [string, () => Promise<unknown>][] = [
      ["redeploy", () => vercel.redeployAction(id, dpl)], ["rollback", () => vercel.rollbackAction(id, dpl)], ["promote", () => vercel.promoteAction(id, dpl)],
      ["cancel", () => vercel.cancelAction(id, dpl)], ["promote preview", () => vercel.promotePreviewAction(id, dpl)],
      ["pause supabase", () => supa.pauseAction(id, "abcdefghijklmnopqrst")], ["restore supabase", () => supa.restoreAction(id, "abcdefghijklmnopqrst")],
      ["wake neon", () => neon.wakeAction(id, "ep-abc-123")], ["edit dns", () => dns.editDnsRecordAction(id, "a".repeat(32), rec as never, rec as never)],
      ["domain re-check", () => domains.recheck(id)], ["sync", () => sync.syncNow(id)], ["save sync", () => sync.saveSyncSelection(id, [], false)],
      ["connect account", () => conns.addAccount("vercel", "Team", "token")], ["check credential", () => conns.checkCredential("vercel", "token")],
      ["replace credential", () => conns.replaceCredential(id, "token")], ["retest", () => conns.retestAccount(id)], ["remove account", () => conns.removeAccount(id)],
      ["telegram chats", () => channels.telegramChats()], ["save telegram", () => channels.saveTelegram("42", "chat")], ["save discord", () => channels.saveDiscord("https://discord.com/api/webhooks/1/x")],
      ["save digest", () => channels.saveDigest("a@example.com")], ["send test", () => channels.sendTest("telegram")],
      ["enable approvals", () => approvals.enableApprovals()], ["disable approvals", () => approvals.disableApprovals()], ["link code", () => approvals.telegramLinkCode()],
      ["scan dependencies", () => deps_.scanDependencies(id)], ["check security", () => security.checkSecurity(id)], ["refresh repo", () => github.refreshRepoActions(id)],
      ["drive connect", () => backups.startDriveConnect()], ["back up", () => backups.backUpNow()], ["run sql", () => sqlA.runSqlAction(id, "select 1", false)],
      ["sql access", () => sqlA.setSqlAccess(id, "postgres://x", false)], ["firestore query", () => sqlA.firestoreQueryAction(id, {})], ["live logs", () => logs.readLastHour(null)],
      ["invite", () => settingsA.inviteUser(null, form)], ["add member", () => settingsA.addMember(null, form)], ["change role", () => settingsA.changeRole(id, "viewer")],
      ["remove member", () => settingsA.removeMember(id)], ["create", () => create.requestCreateAction("supabase_project" as never, "", {})],
      ["create options", () => create.createOptionsAction("supabase_project" as never, "")], ["metrics key", () => metrics.setMetricsKey(id, "abcdefghijklmnopqrst", "sb_secret_x")],
      ["github sync", () => ghSync.syncGithubNow(id)],
    ];
    for (const [name, call] of calls) expect(await call(), name).toEqual({ ok: false, error: DEMO_UNAVAILABLE });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// Each case opens a fresh PGlite visitor database and imports server actions cold (it failed once at 5 s, 26 Oct).
describe("harmless actions are simulated in the visitor's database", { timeout: 60_000 }, () => {
  const SEED = "c0ffee00c0ffee00c0ffee00c0ffee00";
  const fetchSpy = vi.fn(async () => new Response("{}"));
  const realFetch = globalThis.fetch;
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    client = await PGlite.create();
    db = drizzle({ client, schema });
    await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
    // Ten minutes ago, so the newest checks are older than Check now's 50 s "just checked" window.
    await seedDemoDb(db, SEED, new Date(Date.now() - 10 * 60_000), "visitor@example.com");
    h.db = db;
  }, 120_000);
  afterAll(async () => {
    await client.close();
  });
  beforeEach(() => {
    process.env.WATCHPOST_MODE = "demo";
    fetchSpy.mockClear();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    h.member = { id: memberRowId(SEED), userId: demoUserId(SEED), email: "visitor@example.com", role: "owner" };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    restoreMode();
  });

  it("Check now: a simulated passing check through the real writes, no request", async () => {
    const { checkNow } = await import("@/app/(console)/monitor-actions");
    const [m] = await db.select().from(monitors).where(sql`state = 'warn'`); // the degraded one
    const r = await checkNow(m.id);
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/^Answered 200 in \d+ ms\.$/) });
    const [latest] = await db.select().from(checks).where(eq(checks.monitorId, m.id)).orderBy(desc(checks.at)).limit(1);
    expect(latest).toMatchObject({ ok: true, statusCode: 200 });
    expect(Date.now() - latest.at.getTime()).toBeLessThan(60_000);
    const [after] = await db.select().from(monitors).where(eq(monitors.id, m.id));
    expect(after).toMatchObject({ state: "ok", failStreak: 0 });
    expect(await db.select().from(events).where(sql`message = 'Monitor recovered' and at > now() - interval '1 minute'`)).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Refresh now: a simulated collector run and its audit entry, no request", async () => {
    const { refreshNow } = await import("@/app/(console)/refresh-action");
    expect(await refreshNow()).toMatchObject({ ok: true, message: expect.stringContaining("simulated") });
    const [run] = await db.select().from(collectorRuns).orderBy(desc(collectorRuns.finishedAt)).limit(1);
    expect(run).toMatchObject({ trigger: "manual", ok: true });
    expect(Date.now() - run.finishedAt!.getTime()).toBeLessThan(60_000);
    expect(await db.select().from(events).where(sql`type = 'action' and message = 'Collector run requested'`)).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("silencing an alert is a console-only change and works", async () => {
    const { silence } = await import("@/app/(console)/alerts/actions");
    const [firing] = await db.select().from(alerts).where(sql`resolved_at is null and rule_key = 'CertExpiringSoon'`);
    expect(await silence(firing.id, "1h")).toMatchObject({ ok: true });
    const [after] = await db.select().from(alerts).where(eq(alerts.id, firing.id));
    expect(after.silencedUntil).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
