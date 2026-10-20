import "server-only";
import { ENV_COPY } from "@/lib/copy/edition";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { alertRules, alerts, type ChannelKind, channels, checks, monitors, resources, settings, storedLogs } from "@/db/schema";
import { composeMessage, type Notice } from "@/lib/alerts/compose";
import { open as openSealed, seal } from "@/lib/crypto";
import { recordEvents } from "@/lib/data/events-write";
import { readAliasBook } from "./aliases-db";
import { listProviderStatus } from "@/lib/data/provider-status-db";
import { serverEnv } from "@/lib/env";
import { sendDiscord } from "@/lib/notify/discord";
import { buildDigest, type DigestContent, type DigestInput, digestDue, type DigestState, stepDigest } from "@/lib/notify/digest";
import { notifyEnv } from "@/lib/notify/env";
import { type NotifyLang, readNotifyLang, readNotifyLangs } from "@/lib/notify/lang";
import { type ChannelConfig, maskHint } from "@/lib/notify/hints";
import { sendEmail } from "@/lib/notify/resend";
import { type SendResult, sendTelegram } from "@/lib/notify/telegram";
import { tookText } from "@/lib/view/alerts";
import { type AliasBook, EMPTY_BOOK, hideAlert, hideEmails } from "@/lib/view/display-name";
import { wibDay } from "@/lib/view/uptime";
import { PAGE_ROWS } from "@/lib/view/windows";

const DROP_AFTER_MS = 30 * 60_000;
const MIN_LEFT_MS = 6_000;
const HOUR = 3_600_000;
const DIGEST_KEY = "digest.lastSentDay";
const DIGEST_STATE_KEY = "digest.state";
type Push = "telegram" | "discord";
export type Sender = (kind: Push, text: string) => Promise<SendResult>;

export async function readChannel<K extends ChannelKind>(kind: K): Promise<{ row: typeof channels.$inferSelect; config: ChannelConfig[K] } | null> {
  const [row] = await db().select().from(channels).where(eq(channels.kind, kind)).limit(1);
  if (!row) return null;
  try {
    return { row, config: JSON.parse(openSealed({ ciphertext: row.configCiphertext, iv: row.configIv }, serverEnv().OPS_ENCRYPTION_KEY)) as ChannelConfig[K] };
  } catch {
    return null;
  }
}

// The channel's settings are sealed like a credential (spec §6): a webhook URL or a chat id never sits in the table in
// clear text and never goes to the browser.
export async function writeChannel<K extends ChannelKind>(kind: K, config: ChannelConfig[K]): Promise<void> {
  const s = seal(JSON.stringify(config), serverEnv().OPS_ENCRYPTION_KEY);
  const values = { configCiphertext: s.ciphertext, configIv: s.iv, keyVersion: s.keyVersion, enabled: true, lastError: null, updatedAt: new Date() };
  await db().insert(channels).values({ kind, ...values }).onConflictDoUpdate({ target: channels.kind, set: values });
}

export async function setChannelEnabled(kind: ChannelKind, enabled: boolean): Promise<boolean> {
  const r = await db().update(channels).set({ enabled, updatedAt: new Date() }).where(eq(channels.kind, kind)).returning({ kind: channels.kind });
  return r.length > 0;
}

async function defaultSender(): Promise<{ send: Sender; configured: Set<Push> }> {
  const env = notifyEnv();
  const [tg, dc] = await Promise.all([readChannel("telegram"), readChannel("discord")]);
  const configured = new Set<Push>();
  if (env.telegramToken && tg?.row.enabled && tg.config?.chatId) configured.add("telegram");
  if (dc?.row.enabled && dc.config?.url) configured.add("discord");
  const send: Sender = (kind, text) => kind === "telegram" ? sendTelegram(env.telegramToken!, tg!.config.chatId, text) : sendDiscord(dc!.config.url, text);
  return { send, configured };
}

// The connected Telegram chat for a sender outside the alert pipeline (the Kantor Virtual reports): null when Telegram
// isn't connected, is switched off, or TELEGRAM_BOT_TOKEN isn't set. The token and chat id never leave the server.
export async function telegramTarget(): Promise<{ token: string; chatId: string } | null> {
  const token = notifyEnv().telegramToken;
  if (!token) return null;
  const tg = await readChannel("telegram");
  return tg?.row.enabled && tg.config?.chatId ? { token, chatId: tg.config.chatId } : null;
}

// The connected Discord webhook for a sender outside the alert pipeline (the auto-action history): null when Discord
// isn't connected or is switched off. The URL never leaves the server.
export async function discordTarget(): Promise<{ url: string } | null> {
  const dc = await readChannel("discord");
  return dc?.row.enabled && dc.config?.url ? { url: dc.config.url } : null;
}

const CLAIM_MS = 2 * 60_000;

// Privacy: the db-a letters for a notification. If they can't be read the notice still goes out, without emails.
const lettersOrEmpty = (): Promise<AliasBook> => readAliasBook().catch(() => EMPTY_BOOK);

// I3: which rows a delivery may take. A row is free when nobody holds it (claimed_at is null) or the holder's claim is
// older than 2 minutes (it crashed or hung). It must still be pending: a process that read the row before another one
// finished it can't claim it again after the other cleared it.
export function claimable(ids: string[], now: Date) {
  return and(inArray(alerts.id, ids), isNotNull(alerts.pending), or(isNull(alerts.claimedAt), lt(alerts.claimedAt, new Date(now.getTime() - CLAIM_MS))));
}

const isSilenced = (a: { silencedUntil: Date | null; silencedUntilResolved: boolean }, now: Date) =>
  a.silencedUntilResolved || (a.silencedUntil !== null && a.silencedUntil.getTime() > now.getTime());

// S3 / A2: every pending notice, one grouped message per push channel. The watchdog and the minute collector can both
// call this, so the rows are claimed first (one atomic UPDATE … RETURNING, see claimable) and only the claimed ones are
// sent. A notice is cleared when at least one of its channels accepted it, when none of its rule's channels is
// configured, when it was queued before Silence (an open or repeat; a resolve still goes out), or when it has waited 30
// minutes. A dropped open keeps pending_since, so the alert engine retries it 6 hours after the attempt (I1). A failed
// notice stays pending and its claim is released so the next run retries it.
export async function deliverPending(now: Date, deadline: number, deps: { sender?: { send: Sender; configured: Set<Push> } } = {}): Promise<{ sent: number; dropped: number }> {
  if (deadline - Date.now() < MIN_LEFT_MS) return { sent: 0, dropped: 0 };
  // `open` and `repeat` go out only for unresolved rows and `resolve` only for resolved ones, so a stale `open` on a
  // resolved row is never sent. Oldest first, so a backlog beyond 50 drains in order.
  const read = await db().select({ a: alerts, channels: alertRules.channels }).from(alerts).innerJoin(alertRules, eq(alertRules.key, alerts.ruleKey))
    .where(and(isNotNull(alerts.pending), sql`(${alerts.pending} = 'resolve') = (${alerts.resolvedAt} is not null)`)).orderBy(asc(alerts.pendingSince)).limit(50);
  if (!read.length) return { sent: 0, dropped: 0 };
  const claimedIds = new Set((await db().update(alerts).set({ claimedAt: now }).where(claimable(read.map((r) => r.a.id), now)).returning({ id: alerts.id })).map((r) => r.id));
  const rows = read.filter((r) => claimedIds.has(r.a.id));
  if (!rows.length) return { sent: 0, dropped: 0 };
  const { send, configured } = deps.sender ?? (await defaultSender());
  const quiet = new Set(rows.filter(({ a }) => a.pending !== "resolve" && isSilenced(a, now)).map(({ a }) => a.id));
  // Read at send time, once per delivery (a changed setting applies to the next one); unreadable means English. Each
  // channel is composed in its own language, from this one read.
  const [book, langs] = await Promise.all([lettersOrEmpty(), readNotifyLangs()]);
  const accepted = new Set<string>();
  for (const kind of ["telegram", "discord"] as Push[]) {
    if (!configured.has(kind)) continue;
    const mine = rows.filter((r) => r.channels.includes(kind) && !quiet.has(r.a.id));
    if (!mine.length) continue;
    // Privacy: databases by alias and no emails, for every notice whatever its stored text says.
    const notices: Notice[] = mine.map(({ a }) => {
      const shown = hideAlert(a, book);
      return { kind: a.pending!, ruleKey: a.ruleKey, severity: a.severity, title: shown.title, message: shown.message, startedAt: a.startedAt, causedBy: shown.causedBy, provider: a.providerIncident };
    });
    const msg = composeMessage(notices, now, serverEnv().SITE_URL, langs[kind]);
    const r = await send(kind, hideEmails(kind === "telegram" ? msg.telegram : msg.discord));
    await db().update(channels).set(r.ok ? { lastSentAt: now, lastError: null } : { lastError: r.error }).where(eq(channels.kind, kind));
    if (r.ok) mine.forEach(({ a }) => accepted.add(a.id));
  }
  let sent = 0;
  let dropped = 0;
  const release: string[] = [];
  for (const { a, channels: ch } of rows) {
    const reachable = ch.some((c) => configured.has(c as Push));
    const old = a.pendingSince !== null && now.getTime() - a.pendingSince.getTime() > DROP_AFTER_MS;
    if (accepted.has(a.id)) {
      sent++;
      await db().update(alerts).set({ pending: null, pendingSince: null, lastNotifiedAt: now, claimedAt: null, ...(a.pending === "open" ? { notifiedOpen: true } : {}) }).where(eq(alerts.id, a.id));
    } else if (quiet.has(a.id) || !reachable || old) {
      dropped++;
      await db().update(alerts).set({ pending: null, claimedAt: null }).where(eq(alerts.id, a.id));
    } else {
      release.push(a.id);
    }
  }
  if (release.length) await db().update(alerts).set({ claimedAt: null }).where(inArray(alerts.id, release));
  return { sent, dropped };
}

// What the digest says, from bounded reads: firing ≤ 50, resolved ≤ 20, one grouped query each for the 24 h checks and
// stored errors, and the providers whose feed isn't fine. Uptime leaves out checks made inside a maintenance window (U5).
export async function digestData(now: Date): Promise<Omit<DigestInput, "siteUrl">> {
  const since = new Date(now.getTime() - 24 * HOUR);
  const severityOrder = sql`case ${alerts.severity} when 'critical' then 0 when 'warning' then 1 else 2 end`;
  const [firing, openedRows, resolvedRows, apps, providers] = await Promise.all([
    db().select({ ruleKey: alerts.ruleKey, severity: alerts.severity, title: alerts.title, message: alerts.message, resourceId: alerts.resourceId, startedAt: alerts.startedAt }).from(alerts)
      .where(isNull(alerts.resolvedAt)).orderBy(severityOrder, desc(alerts.startedAt)).limit(50),
    db().select({ n: sql<number>`count(*)::int` }).from(alerts).where(gte(alerts.startedAt, since)),
    db().select({ ruleKey: alerts.ruleKey, title: alerts.title, resourceId: alerts.resourceId, startedAt: alerts.startedAt, resolvedAt: alerts.resolvedAt }).from(alerts)
      .where(and(isNotNull(alerts.resolvedAt), gte(alerts.resolvedAt, since))).orderBy(desc(alerts.resolvedAt)).limit(20),
    db().select({ id: resources.id, name: resources.name }).from(resources)
      .where(and(eq(resources.kind, "app"), eq(resources.monitored, true), isNull(resources.goneAt))).orderBy(resources.name).limit(PAGE_ROWS.apps),
    listProviderStatus(now),
  ]);
  const ids = apps.map((a) => a.id);
  const [uptime, errors] = ids.length ? await Promise.all([
    db().select({ id: monitors.resourceId, total: sql<number>`count(*)::int`, bad: sql<number>`(count(*) filter (where not ${checks.ok}))::int` })
      .from(checks).innerJoin(monitors, eq(monitors.id, checks.monitorId)).where(and(inArray(monitors.resourceId, ids), gte(checks.at, since), eq(checks.inMaintenance, false))).groupBy(monitors.resourceId),
    db().select({ id: storedLogs.resourceId, n: sql<number>`count(*)::int` }).from(storedLogs)
      .where(and(inArray(storedLogs.resourceId, ids), gte(storedLogs.at, since))).groupBy(storedLogs.resourceId),
  ]) : [[], []];
  const up = new Map(uptime.map((u) => [u.id, u]));
  const errs = new Map(errors.map((e) => [e.id, e.n]));
  // Privacy: databases by alias and no emails in the alerts' text (buildDigest hides any email left).
  const book = await lettersOrEmpty();
  return {
    now, opened: openedRows[0]?.n ?? 0,
    firing: firing.map(({ resourceId, ...a }) => { const shown = hideAlert({ ...a, resourceId, causedBy: null }, book); return { ...a, title: shown.title, message: shown.message }; }),
    resolved: resolvedRows.flatMap((r) => (r.resolvedAt ? [{ ruleKey: r.ruleKey, title: hideAlert({ title: r.title, message: "", causedBy: null, resourceId: r.resourceId }, book).title, took: tookText(r.startedAt, r.resolvedAt) }] : [])),
    apps: apps.map((a) => {
      const u = up.get(a.id);
      return { name: a.name, uptime: u && u.total > 0 ? ((u.total - u.bad) / u.total) * 100 : null, errors: errs.get(a.id) ?? 0 };
    }),
    providers: providers.filter((p) => p.state !== "ok").map((p) => ({ label: p.label, text: p.text })),
  };
}

// A send's outcome on the channel row (Notifications tab): lastSentAt on success, the error otherwise.
export async function recordResult(kind: ChannelKind, r: SendResult, now: Date): Promise<void> {
  await db().update(channels).set(r.ok ? { lastSentAt: now, lastError: null } : { lastError: r.error }).where(eq(channels.kind, kind));
}

// The digest from live data, in the email language read at build time.
async function liveDigest(now: Date): Promise<DigestContent> {
  const [data, lang] = await Promise.all([digestData(now), readNotifyLang("email")]);
  return buildDigest({ ...data, siteUrl: serverEnv().SITE_URL }, lang);
}

// Builds the digest from live data and sends it through Resend to the saved address. The idempotency key keeps a
// retried send from arriving twice (Resend remembers it for 24 hours).
async function sendDigest(now: Date, idempotencyKey: string): Promise<SendResult> {
  const env = notifyEnv();
  if (!env.resendKey || !env.digestFrom) return { ok: false, kind: "config", error: ENV_COPY.notSet("RESEND_API_KEY or DIGEST_FROM") };
  const ch = await readChannel("email_digest");
  if (!ch?.config?.to) return { ok: false, kind: "config", error: "The daily email digest isn't connected." };
  const d = await liveDigest(now);
  const r = await sendEmail(env.resendKey, { from: env.digestFrom, to: ch.config.to, subject: d.subject, html: d.html, text: d.text, idempotencyKey });
  await recordResult("email_digest", r, now);
  return r;
}

// The `digest` task: due once a WIB day after 07:00 (stepDigest decides). The content is built on the first attempt of the
// day and stored in `digest.state`; retries send that stored content with the same idempotency key, with a bounded
// backoff, and a config error stops the day (I4). When Resend isn't set up, or the channel is missing or off, nothing
// happens and nothing is marked as sent. One event records a digest that couldn't be sent.
export async function taskDigest(now: Date, deps: { build?: () => Promise<DigestContent>; send?: (c: DigestContent) => Promise<SendResult> } = {}): Promise<void> {
  const rows = await db().select().from(settings).where(inArray(settings.key, [DIGEST_KEY, DIGEST_STATE_KEY]));
  const lastRow = rows.find((r) => r.key === DIGEST_KEY)?.value;
  const last = typeof lastRow === "string" ? lastRow : null;
  if (!digestDue(now, last)) return;
  const env = notifyEnv();
  const ch = await readChannel("email_digest");
  if (!env.resendKey || !env.digestFrom || !ch?.row.enabled || !ch.config?.to) return;
  const { resendKey, digestFrom } = env;
  const to = ch.config.to;
  const day = wibDay(now);
  const step = await stepDigest(now, {
    lastSentDay: last,
    state: (rows.find((r) => r.key === DIGEST_STATE_KEY)?.value as DigestState | undefined) ?? null,
    build: deps.build ?? (() => liveDigest(now)),
    send: deps.send ?? ((c) => sendEmail(resendKey, { from: digestFrom, to, ...c, idempotencyKey: `digest-${day}` })),
  });
  if (!step.acted) return;
  if (step.result) await recordResult("email_digest", step.result, now);
  if (step.state) await db().insert(settings).values({ key: DIGEST_STATE_KEY, value: step.state }).onConflictDoUpdate({ target: settings.key, set: { value: step.state, updatedAt: now } });
  else await db().delete(settings).where(eq(settings.key, DIGEST_STATE_KEY));
  if (step.sentDay) await db().insert(settings).values({ key: DIGEST_KEY, value: step.sentDay }).onConflictDoUpdate({ target: settings.key, set: { value: step.sentDay, updatedAt: now } });
  if (step.event) await recordEvents([{ type: "system", kind: "warn", message: step.event.message, detail: step.event.detail, resourceId: null, reason: "DigestFailed", at: now }]);
}

const TEST_NOTICE: Record<NotifyLang, { title: string; message: string }> = {
  en: { title: "Test message", message: "If you can read this, alerts reach you here." },
  id: { title: "Pesan tes", message: "Kalau pesan ini kebaca, alert udah nyampe ke sini." },
};

// Alerts → Notifications → Send test (owner). A message that says so, or the digest built from real data. Both in the
// notification language, so the owner can check the setting with this button.
export async function sendTest(kind: ChannelKind, now: Date, deps: { sender?: { send: Sender; configured: Set<Push> } } = {}): Promise<SendResult> {
  if (kind === "email_digest") return sendDigest(now, `test-${now.getTime()}`);
  const { send, configured } = deps.sender ?? (await defaultSender());
  if (!configured.has(kind)) {
    return { ok: false, kind: "config", error: kind === "telegram" ? `Telegram isn't connected, or ${ENV_COPY.notSet("TELEGRAM_BOT_TOKEN")}` : "Discord isn't connected." };
  }
  const lang = await readNotifyLang(kind);
  const msg = composeMessage([{ kind: "open", ruleKey: "Test", severity: "info", ...TEST_NOTICE[lang], startedAt: now, causedBy: null, provider: null }], now, serverEnv().SITE_URL, lang);
  const r = await send(kind, kind === "telegram" ? msg.telegram : msg.discord);
  await recordResult(kind, r, now);
  return r;
}

export type ChannelView = { kind: ChannelKind; connected: boolean; enabled: boolean; hint: string | null; lastSentAt: Date | null; lastError: string | null; envMissing: string | null };

// For the Notifications tab. Decrypted values stay on the server: only a masked hint goes to the page (R7).
export async function channelViews(): Promise<ChannelView[]> {
  const env = notifyEnv();
  const missing: Record<ChannelKind, string | null> = {
    telegram: env.telegramToken ? null : ENV_COPY.notSet("TELEGRAM_BOT_TOKEN"),
    discord: null,
    email_digest: env.resendKey && env.digestFrom ? null : ENV_COPY.notSet("RESEND_API_KEY or DIGEST_FROM"),
  };
  const [tg, dc, em] = await Promise.all([readChannel("telegram"), readChannel("discord"), readChannel("email_digest")]);
  const view = <K extends ChannelKind>(kind: K, ch: { row: typeof channels.$inferSelect; config: ChannelConfig[K] } | null): ChannelView => ({
    kind, connected: ch !== null, enabled: ch?.row.enabled ?? false, hint: ch ? maskHint(kind, ch.config) : null,
    lastSentAt: ch?.row.lastSentAt ?? null, lastError: ch?.row.lastError ?? null, envMissing: missing[kind],
  });
  return [view("telegram", tg), view("discord", dc), view("email_digest", em)];
}
