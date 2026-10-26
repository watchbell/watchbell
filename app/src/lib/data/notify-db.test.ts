import { beforeEach, describe, expect, it, vi } from "vitest";
import { alerts, channels, checks, events, resources, settings } from "@/db/schema";
import { PgDialect } from "drizzle-orm/pg-core";
import { type Call, fakeDb, payloadOf, whereOf } from "./fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown }, readAliasBook: vi.fn(), readLang: vi.fn(), readLangs: vi.fn(), sendEmail: vi.fn(), readTemplates: vi.fn() }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
// Watchbell 1.2 (D11): the sections the owner turned off (none unless a test says so).
const sec = vi.hoisted(() => ({ paused: new Set<string>() }));
vi.mock("./sections-db", async (orig) => ({ ...(await orig<typeof import("./sections-db")>()), pausedSections: async () => sec.paused }));
vi.mock("@/lib/crypto", () => ({ open: () => JSON.stringify({ to: "me@example.com" }), seal: vi.fn() }));
vi.mock("@/lib/notify/env", () => ({ notifyEnv: () => ({ telegramToken: null, resendKey: "re_x", digestFrom: "Ops <a@b.co>" }) }));
// Privacy: the db-a letters come from their own reader (aliases-db), so the queued reads below stay as they were.
vi.mock("./aliases-db", () => ({ readAliasBook: h.readAliasBook }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: "key", SITE_URL: "https://ops.example.com" }) }));
// The notification language has its own reader (settings-db), so it doesn't take a queued read either.
vi.mock("@/lib/notify/lang", async (orig) => ({ ...(await orig<typeof import("@/lib/notify/lang")>()), readNotifyLang: h.readLang, readNotifyLangs: h.readLangs }));
vi.mock("@/lib/notify/resend", () => ({ sendEmail: h.sendEmail }));
// 1.2.4: the rules' custom texts have their own reader too.
vi.mock("./alerts-db", () => ({ readMessageTemplates: h.readTemplates }));

import { deliverPending, digestData, rememberTelegramThread, sendRuleTest, sendTest, taskDigest, TELEGRAM_THREADS_KEY, telegramThread, THREAD_KEEP_MS } from "./notify-db";

const NOW = new Date("2026-10-13T12:00:00Z");
const alert = (o: Record<string, unknown> = {}) => ({
  id: "al1", ruleKey: "MonitorDown", severity: "critical", title: "orbit-blog /", message: "HTTP 502 for 4 minutes", startedAt: new Date(NOW.getTime() - 240_000),
  causedBy: null, providerIncident: null, pending: "open", pendingSince: new Date(NOW.getTime() - 30_000), resolvedAt: null,
  silencedUntil: null, silencedUntilResolved: false, claimedAt: null, ...o,
});
// Reads: the pending rows. Writes, in order: the claim (what its RETURNING answers), then the channel and alert updates.
const use = (reads: unknown[][], claim: unknown[] = reads[0]?.map((r) => ({ id: (r as { a: { id: string } }).a.id })) ?? []) => {
  const f = fakeDb(reads, [claim]);
  h.current = f;
  return f;
};
const ok = { ok: true as const };
const fail = { ok: false as const, kind: "transient" as const, error: "Telegram didn't answer." };
const deadline = () => Date.now() + 20_000;
const alertWrites = (f: ReturnType<typeof use>) => f.writes.filter((w) => w.table === alerts);

beforeEach(() => {
  h.current = null;
  sec.paused = new Set();
  h.readAliasBook.mockReset();
  h.readLang.mockReset();
  h.readLang.mockResolvedValue("en");
  h.readLangs.mockReset();
  h.readLangs.mockResolvedValue({ telegram: "en", discord: "en", email: "en" });
  h.sendEmail.mockReset();
  h.readTemplates.mockReset();
  h.readTemplates.mockResolvedValue({});
  h.readAliasBook.mockResolvedValue({ db: [{ id: "db1", name: "someone@gmail.com's Project", alias: "db-a" }, { id: "db2", name: "ticketer", alias: "db-b" }], app: [] });
});

describe("notifications never name a database or show an email (privacy)", () => {
  // Watchbell 1.2.2 (D18): Telegram is the owner's own chat, so it keeps the real names (still never an email).
  it("Discord gets the alias, for the alert's own database and one named in its text; Telegram the real name", async () => {
    use([[
      { a: alert({ id: "x1", ruleKey: "DatabasePaused", resourceId: "db1", title: "someone@gmail.com's Project", message: "Supabase project someone@gmail.com's Project is paused." }), channels: ["telegram", "discord"] },
      { a: alert({ id: "x2", resourceId: "app1", title: "web /", message: "HTTP 502", causedBy: "DatabasePaused · ticketer" }), channels: ["telegram", "discord"] },
    ]]);
    const send = vi.fn().mockResolvedValue(ok);
    await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["telegram", "discord"]) } });
    const text = Object.fromEntries(send.mock.calls.map(([kind, t]) => [kind, t as string]));
    expect(text.discord).not.toMatch(/gmail|ticketer/);
    expect(text.discord).toContain("db-a");
    expect(text.discord).toContain("caused by DatabasePaused · db-b");
    expect(text.telegram).not.toMatch(/gmail|db-a|db-b/);
    expect(text.telegram).toContain("Supabase project [email hidden]'s Project is paused.");
    expect(text.telegram).toContain("caused by DatabasePaused · ticketer");
  });

  // 1.2.3: the webhook gets the same masked text as Discord plus the alerts as data, also masked (it leaves the machine).
  it("the webhook gets the alias and no email, in the text and in the alerts it carries", async () => {
    use([[
      { a: alert({ id: "x1", ruleKey: "DatabasePaused", resourceId: "db1", title: "someone@gmail.com's Project", message: "Supabase project someone@gmail.com's Project is paused." }), channels: ["webhook"] },
    ]]);
    const send = vi.fn().mockResolvedValue(ok);
    expect(await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["webhook"]) } })).toEqual({ sent: 1, dropped: 0 });
    const [kind, text, notices] = send.mock.calls[0] as [string, string, { title: string; message: string; ruleKey: string }[]];
    expect(kind).toBe("webhook");
    expect(text).not.toMatch(/gmail/);
    expect(text).toContain("db-a");
    expect(notices).toHaveLength(1);
    expect(notices[0].ruleKey).toBe("DatabasePaused");
    expect(`${notices[0].title} ${notices[0].message}`).not.toMatch(/gmail/);
  });

  it("still sends, without emails, when the letters can't be read", async () => {
    h.readAliasBook.mockRejectedValue(new Error("down"));
    use([[{ a: alert({ title: "supabase · me@gmail.com", message: "expires" }), channels: ["telegram"] }]]);
    const send = vi.fn().mockResolvedValue(ok);
    expect(await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["telegram"]) } })).toEqual({ sent: 1, dropped: 0 });
    expect(send.mock.calls[0][1]).not.toContain("me@gmail.com");
  });

  it("the digest's alerts use the alias", async () => {
    const from = (calls: { method: string; args: unknown[] }[]) => calls.find((c) => c.method === "from")?.args[0];
    const selects = (calls: { method: string; args: unknown[] }[]) => Object.keys((calls.find((c) => c.method === "select")?.args[0] ?? {}) as object);
    const answer = (calls: { method: string; args: unknown[] }[]) => {
      if (from(calls) !== alerts) return [];
      const cols = selects(calls);
      if (cols.includes("message")) return [{ ruleKey: "DatabasePaused", severity: "warning", title: "ticketer", message: "Supabase project ticketer is paused.", resourceId: "db2", startedAt: NOW }];
      if (cols.includes("resolvedAt")) return [{ ruleKey: "StorageAlmostFull", title: "someone@gmail.com's Project", resourceId: "db1", startedAt: NOW, resolvedAt: NOW }];
      return [{ n: 1 }];
    };
    h.current = fakeDb(Array.from({ length: 10 }, () => answer));
    const d = await digestData(NOW);
    expect(d.firing.map((a) => [a.title, a.message])).toEqual([["db-b", "Supabase project db-b is paused."]]);
    expect(d.resolved.map((r) => r.title)).toEqual(["db-a"]);
  });
});

// Review focus 5: a paused section's notices aren't read, so they are neither sent nor dropped while it is off.
describe("deliverPending with a paused section (D11)", () => {
  const whereSql = (calls: Call[]) => new PgDialect().sqlToQuery(whereOf(calls)!.getSQL() as never);
  it("reads only the notices of sections that are on, and leaves the paused ones queued", async () => {
    sec.paused = new Set(["hosting"]);
    const f = use([[]]);
    const send = vi.fn().mockResolvedValue(ok);
    expect(await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["telegram"]) } })).toEqual({ sent: 0, dropped: 0 });
    const q = whereSql(f.queries[0]);
    expect(q.sql).toContain("not (");
    expect(q.params).toEqual(expect.arrayContaining(["MonitorDown", "HighLatency", "DeploymentFailed", "vercel", "cloudflare"]));
    expect(q.params).not.toContain("DatabasePaused");
    expect(f.writes).toEqual([]); // no claim, no drop
    expect(send).not.toHaveBeenCalled();
  });

  it("reads every pending notice when nothing is paused", async () => {
    const f = use([[]]);
    await deliverPending(NOW, deadline(), { sender: { send: vi.fn(), configured: new Set(["telegram"]) } });
    expect(whereSql(f.queries[0]).sql).not.toContain("not (");
  });

  it("leaves a paused section's alerts out of the digest's firing list", async () => {
    sec.paused = new Set(["database"]);
    const f = fakeDb([]);
    h.current = f;
    await digestData(NOW);
    const firing = f.queries.find((q) => q.some((c) => c.method === "select" && "message" in ((c.args[0] ?? {}) as object)))!;
    expect(whereSql(firing).params).toEqual(expect.arrayContaining(["DatabasePaused", "supabase"]));
  });
});

describe("sendRuleTest (1.2.4)", () => {
  it("sends the rule's text in each channel's language and names a channel that isn't connected", async () => {
    h.readLangs.mockResolvedValue({ telegram: "id", discord: "en", email: "en" });
    use([]);
    const send = vi.fn().mockResolvedValue(ok);
    const notice = { kind: "open" as const, ruleKey: "MonitorDown", severity: "critical" as const, title: "my-app", message: "3 failed checks in a row", startedAt: NOW, causedBy: null, provider: null, threshold: 3 };
    const r = await sendRuleTest(["telegram", "discord"], notice, { MonitorDown: { id: "{target} mati, {threshold}x gagal" } }, NOW, { sender: { send, configured: new Set(["telegram"]) } });
    expect(r).toEqual([{ kind: "telegram", result: ok }, { kind: "discord", result: { ok: false, kind: "config", error: "Discord isn't connected." } }]);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1]).toContain("<b>my-app mati, 3x gagal</b>");
    // Owner 26 Oct: marked as a test, and the sample sentence in the channel's language (not the English condition).
    expect(send.mock.calls[0][1]).toMatch(/^<b>Watchbell \(tes\)<\/b>: 1 aktif/);
    const plain = await sendRuleTest(["telegram"], { ...notice, ruleKey: "HighLatency" }, {}, NOW, { sender: { send, configured: new Set(["telegram"]) } });
    expect(plain[0].result).toEqual(ok);
    expect(send.mock.calls[1][1]).toContain("Pesan tes: di sini nanti kalimat Watchbell");
    expect(send.mock.calls[1][1]).not.toContain("failed checks");
  });
});

describe("deliverPending", () => {
  it("1.2.4: writes a rule with its own text in each channel's language, with the rule's threshold", async () => {
    h.readLangs.mockResolvedValue({ telegram: "id", discord: "en", email: "en" });
    h.readTemplates.mockResolvedValue({ HighLatency: { id: "{target} lambat, batas {threshold} ms" } });
    use([[{ a: alert({ ruleKey: "HighLatency", severity: "warning", title: "api /" }), channels: ["telegram", "discord"], threshold: 2000 }]]);
    const send = vi.fn().mockResolvedValue(ok);
    await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["telegram", "discord"]) } });
    const text = Object.fromEntries(send.mock.calls.map(([kind, t]) => [kind, t as string]));
    expect(text.telegram).toContain("<b>api / lambat, batas 2,000 ms</b>");
    expect(text.discord).toContain("FIRING · warning · HighLatency · api /");
  });

  it("sends one grouped message and marks the alert as notified, releasing the claim", async () => {
    const f = use([[{ a: alert(), channels: ["telegram"] }]]);
    const send = vi.fn().mockResolvedValue(ok);
    const r = await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["telegram"]) } });
    expect(r).toEqual({ sent: 1, dropped: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("telegram");
    expect(send.mock.calls[0][1]).toContain("FIRING · critical · MonitorDown");
    const upd = alertWrites(f);
    expect(upd).toHaveLength(2); // the claim, then the result
    expect(payloadOf(upd[1].calls)).toEqual({ pending: null, pendingSince: null, lastNotifiedAt: NOW, notifiedOpen: true, claimedAt: null });
    expect(payloadOf(f.writes.find((w) => w.table === channels)!.calls)).toEqual({ lastSentAt: NOW, lastError: null });
  });

  it("sends one message per channel however many alerts changed, and a resolve doesn't set notifiedOpen", async () => {
    const f = use([[
      { a: alert({ id: "a1" }), channels: ["telegram", "discord"] },
      { a: alert({ id: "a2", pending: "resolve", resolvedAt: NOW }), channels: ["telegram", "discord"] },
      { a: alert({ id: "a3", pending: "repeat" }), channels: ["discord"] },
    ]]);
    const send = vi.fn().mockResolvedValue(ok);
    const r = await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["telegram", "discord"]) } });
    expect(r).toEqual({ sent: 3, dropped: 0 });
    expect(send.mock.calls.map((c) => c[0])).toEqual(["telegram", "discord"]);
    expect(send.mock.calls[1][1]).toContain("REPEAT");
    const updates = alertWrites(f).slice(1).map((w) => payloadOf(w.calls));
    expect(updates.map((u) => "notifiedOpen" in (u ?? {}))).toEqual([true, false, false]);
  });

  it("keeps a failed notice pending, releases its claim, and records the error on the channel", async () => {
    const f = use([[{ a: alert(), channels: ["telegram"] }]]);
    const send = vi.fn().mockResolvedValue(fail);
    const r = await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["telegram"]) } });
    expect(r).toEqual({ sent: 0, dropped: 0 });
    const upd = alertWrites(f);
    expect(upd).toHaveLength(2);
    expect(payloadOf(upd[1].calls)).toEqual({ claimedAt: null });
    expect(payloadOf(f.writes.find((w) => w.table === channels)!.calls)).toEqual({ lastError: "Telegram didn't answer." });
  });

  it("drops a notice that has failed for more than 30 minutes, keeping when the attempt began so the open can retry later (I1)", async () => {
    const f = use([[{ a: alert({ pendingSince: new Date(NOW.getTime() - 31 * 60_000) }), channels: ["telegram"] }]]);
    const send = vi.fn().mockResolvedValue(fail);
    const r = await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["telegram"]) } });
    expect(r).toEqual({ sent: 0, dropped: 1 });
    expect(payloadOf(alertWrites(f)[1].calls)).toEqual({ pending: null, claimedAt: null });
  });

  it("clears a notice whose rule has no configured push channel, without sending", async () => {
    const f = use([[{ a: alert({ pending: "resolve", resolvedAt: NOW }), channels: ["email_digest"] }]]);
    const send = vi.fn();
    const r = await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["telegram"]) } });
    expect(send).not.toHaveBeenCalled();
    expect(r).toEqual({ sent: 0, dropped: 1 });
    expect(payloadOf(alertWrites(f)[1].calls)).toEqual({ pending: null, claimedAt: null });
  });

  it("doesn't send an open or repeat that was queued before Silence, but still sends the resolve (M1)", async () => {
    use([[
      { a: alert({ id: "s1", silencedUntilResolved: true }), channels: ["telegram"] },
      { a: alert({ id: "s2", pending: "repeat", silencedUntil: new Date(NOW.getTime() + 60_000) }), channels: ["telegram"] },
      { a: alert({ id: "s3", pending: "resolve", resolvedAt: NOW, silencedUntilResolved: true }), channels: ["telegram"] },
    ]]);
    const send = vi.fn().mockResolvedValue(ok);
    const r = await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["telegram"]) } });
    expect(r).toEqual({ sent: 1, dropped: 2 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toContain("RESOLVED");
    expect(send.mock.calls[0][1]).not.toContain("FIRING");
  });

  it("does nothing, not even a read, when under 6 s of the run remain", async () => {
    const f = use([[{ a: alert(), channels: ["telegram"] }]]);
    const send = vi.fn();
    expect(await deliverPending(NOW, Date.now() + 5_000, { sender: { send, configured: new Set(["telegram"]) } })).toEqual({ sent: 0, dropped: 0 });
    expect(f.queries).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("reads nothing more when nothing is pending, and reads the oldest first", async () => {
    const f = use([[]]);
    const send = vi.fn();
    expect(await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["telegram"]) } })).toEqual({ sent: 0, dropped: 0 });
    expect(f.writes).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(f.queries[0].some((c) => c.method === "orderBy")).toBe(true);
  });
});

// I3: the watchdog and the minute collector can run deliverPending at the same time. Rows are claimed with one atomic
// UPDATE … WHERE (not claimed or claim older than 2 minutes) … RETURNING, and only what the claim returns is sent.
describe("deliverPending claim", () => {
  it("claims every row it read in one update with RETURNING, before sending anything", async () => {
    const f = use([[{ a: alert({ id: "a1" }), channels: ["telegram"] }, { a: alert({ id: "a2" }), channels: ["telegram"] }]]);
    const order: string[] = [];
    const send = vi.fn().mockImplementation(async () => { order.push(`send after ${f.writes.length} write(s)`); return ok; });
    await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["telegram"]) } });
    const claim = f.writes[0];
    expect(claim.kind).toBe("update");
    expect(claim.table).toBe(alerts);
    expect(payloadOf(claim.calls)).toEqual({ claimedAt: NOW });
    expect(claim.calls.map((c) => c.method)).toEqual(expect.arrayContaining(["set", "where", "returning"]));
    expect(order).toEqual(["send after 1 write(s)"]);
  });

  it("sends only the rows this process claimed: a row another process holds is left alone", async () => {
    const f = use([[{ a: alert({ id: "mine" }), channels: ["telegram"] }, { a: alert({ id: "theirs", title: "other alert" }), channels: ["telegram"] }]], [{ id: "mine" }]);
    const send = vi.fn().mockResolvedValue(ok);
    const r = await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["telegram"]) } });
    expect(r).toEqual({ sent: 1, dropped: 0 });
    expect(send.mock.calls[0][1]).toContain("orbit-blog /");
    expect(send.mock.calls[0][1]).not.toContain("other alert");
    expect(alertWrites(f)).toHaveLength(2); // the claim and the result of "mine" only
  });

  it("sends nothing and touches nothing else when another process already holds every row", async () => {
    const f = use([[{ a: alert(), channels: ["telegram"] }]], []);
    const send = vi.fn();
    expect(await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["telegram"]) } })).toEqual({ sent: 0, dropped: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(1);
    expect(f.writes.some((w) => w.table === channels)).toBe(false);
  });
});

describe("claimable", () => {
  it("takes pending rows that nobody holds, or whose claim is older than 2 minutes", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const { claimable } = await import("./notify-db");
    const q = new PgDialect().sqlToQuery(claimable(["a1", "a2"], NOW)!);
    expect(q.sql).toContain('"claimed_at" is null');
    expect(q.sql).toMatch(/"claimed_at" < \$/);
    expect(q.sql).toContain('"pending" is not null');
    expect(q.params).toEqual(expect.arrayContaining(["a1", "a2", new Date(NOW.getTime() - 120_000).toISOString()]));
  });
});

// I4: taskDigest stores the content on the first attempt and resends it; a config error stops the day with one event.
describe("taskDigest", () => {
  const AT = new Date("2026-10-13T00:00:00Z"); // 07:00 WIB
  const content = { subject: "Watchbell · 13 Oct · 0 firing, 0 opened, 0 resolved", html: "<p>x</p>", text: "x" };
  const chan = { kind: "email_digest", enabled: true, configCiphertext: "c", configIv: "i", lastSentAt: null, lastError: null };
  const state = (o: Record<string, unknown> = {}) => ({ key: "digest.state", value: { day: "2026-10-13", ...content, attempts: 1, lastAttemptAt: new Date(AT.getTime() - 20 * 60_000).toISOString(), stopped: false, lastError: "e", ...o } });
  const run = async (settingsRows: unknown[], send: ReturnType<typeof vi.fn>, channel: unknown[] = [chan], now = AT) => {
    const f = fakeDb([settingsRows, channel]);
    h.current = f;
    const build = vi.fn().mockResolvedValue(content);
    await taskDigest(now, { build, send: send as never });
    return { f, build };
  };
  const payloads = (f: ReturnType<typeof fakeDb>, table: unknown, kind?: string) => f.writes.filter((w) => w.table === table && (!kind || w.kind === kind)).map((w) => payloadOf(w.calls));

  it("builds and sends once, marks the day as sent and clears the stored content", async () => {
    const send = vi.fn().mockResolvedValue(ok);
    const { f, build } = await run([], send);
    expect(build).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(content);
    expect(payloads(f, settings, "insert")).toEqual([{ key: "digest.lastSentDay", value: "2026-10-13" }]);
    expect(f.writes.some((w) => w.table === settings && w.kind === "delete")).toBe(true);
    expect(payloads(f, channels)).toEqual([{ lastSentAt: AT, lastError: null }]);
  });

  it("stores the built content after a transient failure and resends exactly that content later", async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, kind: "transient", error: "Resend didn't answer." });
    const { f } = await run([], send);
    const saved = payloads(f, settings, "insert")[0] as { key: string; value: Record<string, unknown> };
    expect(saved.key).toBe("digest.state");
    expect(saved.value).toMatchObject({ ...content, attempts: 1, stopped: false });
    expect(payloads(f, events)).toEqual([]);
    const later = vi.fn().mockResolvedValue(ok);
    const second = await run([{ key: "digest.state", value: saved.value }], later, [chan], new Date(AT.getTime() + 6 * 60_000));
    expect(second.build).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledWith(content);
  });

  it("doesn't try again before the backoff gap has passed", async () => {
    const send = vi.fn();
    const { f } = await run([state({ attempts: 1, lastAttemptAt: new Date(AT.getTime() - 2 * 60_000).toISOString() })], send);
    expect(send).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });

  it("stops the day after a config error and records one event", async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, kind: "config", error: "Resend: Invalid from" });
    const { f } = await run([], send);
    expect((payloads(f, settings, "insert")[0] as { value: Record<string, unknown> }).value).toMatchObject({ stopped: true, attempts: 1 });
    expect(payloads(f, events, "insert")).toEqual([expect.objectContaining({ type: "system", kind: "warn", message: "Daily digest not sent", reason: "DigestFailed" })]);
    expect(payloads(f, channels)).toEqual([{ lastError: "Resend: Invalid from" }]);
  });

  it("does nothing when the digest was already sent today, or the channel is off", async () => {
    const send = vi.fn();
    const sent = await run([{ key: "digest.lastSentDay", value: "2026-10-13" }], send);
    expect(sent.f.writes).toEqual([]);
    const off = await run([], send, [{ ...chan, enabled: false }]);
    expect(off.f.writes).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("digestData (U5)", () => {
  it("leaves checks made inside a maintenance window out of each app's uptime", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    // Each read answers by the table it reads (the reads run side by side, so their order isn't fixed).
    const from = (calls: { method: string; args: unknown[] }[]) => calls.find((c) => c.method === "from")?.args[0];
    const answer = (calls: { method: string; args: unknown[] }[]) => (from(calls) === resources ? [{ id: "a1", name: "web" }] : from(calls) === checks ? [{ id: "a1", total: 10, bad: 1 }] : []);
    const f = fakeDb(Array.from({ length: 10 }, () => answer));
    h.current = f;
    const d = await digestData(NOW);
    expect(d.apps).toEqual([{ name: "web", uptime: 90, errors: 0 }]);
    const q = f.queries.find((calls) => calls.some((c) => c.method === "from" && c.args[0] === checks));
    const where = new PgDialect().sqlToQuery(q?.find((c) => c.method === "where")?.args[0] as never);
    expect(where.sql).toMatch(/"in_maintenance" = \$\d+/);
    expect(where.params).toContain(false);
  });
});

// Notification language (owner 19 Oct): read once per delivery, at send time; English when it isn't set.
describe("the notification language", () => {
  // One stored setting feeds both readers, as in production.
  const setLangs = (l: { telegram: string; discord: string; email: string }) => {
    h.readLangs.mockResolvedValue(l);
    h.readLang.mockImplementation(async (c: "telegram" | "discord" | "email" = "telegram") => l[c]);
  };
  const from = (calls: { method: string; args: unknown[] }[]) => calls.find((c) => c.method === "from")?.args[0];
  const selects = (calls: { method: string; args: unknown[] }[]) => Object.keys((calls.find((c) => c.method === "select")?.args[0] ?? {}) as object);
  const chan = { kind: "email_digest", enabled: true, configCiphertext: "c", configIv: "i", lastSentAt: null, lastError: null };
  // Every read answers by its table, whatever order the parallel reads run in.
  const answer = (calls: { method: string; args: unknown[] }[]) => {
    if (from(calls) === channels) return [chan];
    if (from(calls) !== alerts) return [];
    const cols = selects(calls);
    if (cols.includes("message")) return [{ ruleKey: "DatabasePaused", severity: "warning", title: "ticketer", message: "Supabase project ticketer is paused.", resourceId: "db2", startedAt: NOW }];
    return cols.includes("resolvedAt") ? [] : [{ n: 1 }];
  };

  it("sends the grouped alert in Indonesian to every channel, reading the setting once", async () => {
    setLangs({ telegram: "id", discord: "id", email: "id" });
    use([[
      { a: alert({ id: "a1", message: "orbit-blog.vercel.app/ returned HTTP 502 on 3 consecutive checks." }), channels: ["telegram", "discord"] },
      { a: alert({ id: "a2", pending: "resolve", resolvedAt: NOW, ruleKey: "HighLatency", severity: "warning" }), channels: ["telegram", "discord"] },
    ]]);
    const send = vi.fn().mockResolvedValue(ok);
    expect(await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["telegram", "discord"]) } })).toEqual({ sent: 2, dropped: 0 });
    expect(h.readLangs).toHaveBeenCalledTimes(1);
    for (const [, text] of send.mock.calls) {
      expect(text).toContain("1 aktif, 1 pulih");
      expect(text).toContain("MUNCUL · kritis · MonitorDown");
      expect(text).toContain("orbit-blog.vercel.app/: 3 cek gagal berturut-turut (HTTP 502).");
      expect(text).toContain("PULIH · peringatan · HighLatency");
    }
  });

  it("composes Telegram in Indonesian and Discord in English from one claim and one settings read", async () => {
    setLangs({ telegram: "id", discord: "en", email: "en" });
    use([[{ a: alert(), channels: ["telegram", "discord"] }]]);
    const send = vi.fn().mockResolvedValue(ok);
    expect(await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["telegram", "discord"]) } })).toEqual({ sent: 1, dropped: 0 });
    expect(h.readLangs).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.map((c) => c[0])).toEqual(["telegram", "discord"]);
    expect(send.mock.calls[0][1]).toContain("MUNCUL · kritis · MonitorDown");
    expect(send.mock.calls[1][1]).toContain("FIRING · critical · MonitorDown");
    expect(send.mock.calls[1][1]).not.toContain("MUNCUL");
    setLangs({ telegram: "en", discord: "id", email: "en" });
    use([[{ a: alert(), channels: ["telegram", "discord"] }]]);
    send.mockClear();
    await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["telegram", "discord"]) } });
    expect(send.mock.calls[0][1]).toContain("FIRING · critical");
    expect(send.mock.calls[1][1]).toContain("MUNCUL · kritis");
  });

  it("stays English when the setting says so", async () => {
    use([[{ a: alert(), channels: ["telegram"] }]]);
    const send = vi.fn().mockResolvedValue(ok);
    await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["telegram"]) } });
    expect(send.mock.calls[0][1]).toContain("FIRING · critical · MonitorDown");
  });

  it("doesn't read the setting when there's nothing to send", async () => {
    use([[]]);
    await deliverPending(NOW, deadline(), { sender: { send: vi.fn(), configured: new Set(["telegram"]) } });
    expect(h.readLangs).not.toHaveBeenCalled();
  });

  it("each channel's Test message follows that channel's language", async () => {
    setLangs({ telegram: "en", discord: "id", email: "en" });
    h.current = fakeDb([], []);
    const send = vi.fn().mockResolvedValue(ok);
    expect(await sendTest("discord", NOW, { sender: { send, configured: new Set(["telegram", "discord"]) } })).toEqual(ok);
    expect(send).toHaveBeenCalledWith("discord", expect.stringContaining("**MUNCUL · info · Test · Pesan tes**"));
    expect(send.mock.calls[0][1]).toContain("Kalau pesan ini kebaca, alert udah nyampe ke sini.");
    await sendTest("telegram", NOW, { sender: { send, configured: new Set(["telegram"]) } });
    expect(send.mock.calls[1][1]).toContain("FIRING · info · Test · Test message");
  });

  it("the digest's Send test and the daily digest use the email language, not Telegram's", async () => {
    setLangs({ telegram: "en", discord: "en", email: "id" });
    h.sendEmail.mockResolvedValue(ok);
    h.current = fakeDb(Array.from({ length: 12 }, () => answer));
    await sendTest("email_digest", NOW);
    const mail = h.sendEmail.mock.calls[0][1] as { subject: string; text: string };
    expect(mail.subject).toMatch(/^Watchbell · 13 Okt · 1 aktif, 1 baru, 0 pulih$/);
    expect(mail.text).toContain("peringatan · DatabasePaused · db-b: Project Supabase db-b lagi di-pause.");

    const AT = new Date("2026-10-13T00:00:00Z"); // 07:00 WIB, the digest is due
    h.current = fakeDb(Array.from({ length: 12 }, () => answer));
    const send = vi.fn().mockResolvedValue(ok);
    await taskDigest(AT, { send });
    expect((send.mock.calls[0][0] as { subject: string }).subject).toMatch(/^Watchbell · 13 Okt · 1 aktif/);
  });

  it("an English email language keeps the digest English even when Telegram is Indonesian", async () => {
    setLangs({ telegram: "id", discord: "id", email: "en" });
    h.sendEmail.mockResolvedValue(ok);
    h.current = fakeDb(Array.from({ length: 12 }, () => answer));
    await sendTest("email_digest", NOW);
    expect((h.sendEmail.mock.calls[0][1] as { subject: string }).subject).not.toMatch(/Okt/);
  });
});

// Watchbell 1.2.2 (D18): the Telegram message that opened an alert, so its auto-actions reply to it.
describe("Telegram threads (D18)", () => {
  const A1 = "11111111-1111-4111-8111-111111111111";
  const A2 = "22222222-2222-4222-8222-222222222222";
  const render = (q: unknown) => new PgDialect().sqlToQuery(q as never);
  const threadWrites = (f: ReturnType<typeof use>) => f.writes.filter((w) => w.table === settings);

  it("remembers the message id of an opening Telegram message, for the opened alerts only", async () => {
    const f = use([[
      { a: alert({ id: A1 }), channels: ["telegram", "discord"] },
      { a: alert({ id: A2, pending: "resolve", resolvedAt: NOW }), channels: ["telegram"] },
    ]]);
    const send = vi.fn(async (kind: string) => (kind === "telegram" ? { ok: true as const, messageId: 501 } : { ok: true as const, messageId: 9 }));
    expect(await deliverPending(NOW, deadline(), { sender: { send, configured: new Set(["telegram", "discord"]) } })).toEqual({ sent: 2, dropped: 0 });
    const w = threadWrites(f);
    expect(w).toHaveLength(1);
    expect(payloadOf(w[0].calls)).toEqual({ key: TELEGRAM_THREADS_KEY, value: { [A1]: { m: 501, at: NOW.getTime() } } });
    // The stored entry wins over a new one, and entries older than a week go, in the same statement.
    const upsert = w[0].calls.find((c) => c.method === "onConflictDoUpdate")?.args[0] as { set: { value: unknown } };
    const q = render(upsert.set.value);
    expect(q.sql).toContain("jsonb_each");
    expect(q.sql).toMatch(/\|\| case when jsonb_typeof/);
    expect(q.params).toEqual(expect.arrayContaining([NOW.getTime() - THREAD_KEEP_MS]));
  });

  it("remembers nothing without a message id, for a failed send, or for a resolve or repeat only", async () => {
    for (const [rows, result] of [
      [[{ a: alert({ id: A1 }), channels: ["telegram"] }], ok],
      [[{ a: alert({ id: A1 }), channels: ["telegram"] }], fail],
      [[{ a: alert({ id: A1, pending: "repeat" }), channels: ["telegram"] }], { ok: true as const, messageId: 5 }],
    ] as const) {
      const f = use([rows as unknown as unknown[]]);
      await deliverPending(NOW, deadline(), { sender: { send: vi.fn().mockResolvedValue(result), configured: new Set(["telegram"]) } });
      expect(threadWrites(f)).toEqual([]);
    }
  });

  it("a failed write never stops the delivery", async () => {
    use([[{ a: alert({ id: A1 }), channels: ["telegram"] }]]);
    const f = h.current as ReturnType<typeof fakeDb>;
    const conn = f.db() as { insert: (t: unknown) => unknown };
    const insert = conn.insert;
    conn.insert = (t: unknown) => { if (t === settings) throw new Error("db down"); return insert(t); };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await deliverPending(NOW, deadline(), { sender: { send: vi.fn().mockResolvedValue({ ok: true, messageId: 3 }), configured: new Set(["telegram"]) } })).toEqual({ sent: 1, dropped: 0 });
    expect(warn).toHaveBeenCalledWith("notify: remembering the Telegram message failed");
    warn.mockRestore();
  });

  it("rememberTelegramThread ignores ids that aren't alert ids and bad message ids", async () => {
    const f = fakeDb([]);
    h.current = f;
    await rememberTelegramThread(["x1", ""], 5, NOW);
    await rememberTelegramThread([A1], 0, NOW);
    await rememberTelegramThread([A1], 1.5, NOW);
    expect(f.writes).toEqual([]);
  });

  it("telegramThread reads the stored message id, null for anything else", async () => {
    h.current = fakeDb([[{ value: { [A1]: { m: 501, at: 1 } } }], [{ value: { [A1]: { m: 501, at: 1 }, [A2]: { m: "x" } } }], [], new Error("down")]);
    expect(await telegramThread(A1)).toBe(501);
    expect(await telegramThread(A2)).toBeNull();
    expect(await telegramThread(A1)).toBeNull();
    expect(await telegramThread(A1)).toBeNull();
    expect(await telegramThread("not-an-id")).toBeNull();
    expect(await telegramThread(null)).toBeNull();
  });
});

describe("email subject (1.2.3)", () => {
  it("is the message's first line without Discord's markdown", async () => {
    const { mailSubject } = await import("./notify-db");
    expect(mailSubject("**FIRING** · critical · `orbit-blog` down\nmore")).toBe("FIRING · critical · orbit-blog down");
    expect(mailSubject("")).toBe("Watchbell alert");
  });
  it("the body is plain text: no Discord marks, the link once (26 Oct test mail)", async () => {
    const { mailBody } = await import("./notify-db");
    const text = "**Watchbell**: 1 aktif · 17:16 WIB\n\n**MUNCUL · info · Test · Pesan tes**\nKalau pesan ini kebaca, alert udah nyampe ke sini.\n_karena DatabasePaused · db-a_ and `ops_app`\n\nhttps://ops.example.com/alerts";
    const body = mailBody(text);
    expect(body).toBe("Watchbell: 1 aktif · 17:16 WIB\n\nMUNCUL · info · Test · Pesan tes\nKalau pesan ini kebaca, alert udah nyampe ke sini.\nkarena DatabasePaused · db-a and ops_app\n\nhttps://ops.example.com/alerts");
    expect(body.match(/https:\/\//g)).toHaveLength(1);
  });
});
