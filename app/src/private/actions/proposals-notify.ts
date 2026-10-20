import "server-only";
import { ACTIONS_COPY } from "@/lib/copy/edition";
import { aliasBook } from "@/lib/data/cached";
import { discordTarget, recordResult, telegramTarget } from "@/lib/data/notify-db";
import { sendDiscord } from "@/lib/notify/discord";
import { esc } from "@/lib/alerts/compose";
import { serverEnv } from "@/lib/env";
import { type NotifyLang, readNotifyLang, t } from "@/lib/notify/lang";
import { type SendResult, sendTelegram } from "@/lib/notify/telegram";
import type { InlineKeyboard } from "@/lib/notify/telegram-bot";
import { type AliasBook, EMPTY_BOOK } from "@/lib/view/display-name";
import { cleanLine } from "@/private/console/clean-text";
import { readAutoRun } from "./proposals-settings";
import { ACTIONS, type AutoRun, type Proposal, type ProposalAction } from "./proposals-types";

// Stage 9 slice 1: the Telegram notice of an officer's proposal. Same channel as the office reports (report-telegram.ts):
// the connected Telegram chat (Alerts → Notifications), same bot, lastSentAt / lastError recorded; not connected → nothing.
// The message links to the proposal in Kantor Virtual, where the owner approves or rejects it. Stage 9 slice 7: while the
// Telegram approval buttons are on (webhook set, owner linked), a single notice also carries [✅ Approve] [❌ Reject] and a
// "Status: ⏳ waiting" line (telegram-approvals.ts); a grouped one keeps only the links. Every text goes through the office scrub (console/clean-text.ts): no hostname, email or key leaves. English or Indonesian (notify.language, read at send time), short.
// Neither function ever throws, and each gives up after NOTIFY_TIMEOUT_MS.

export const NOTIFY_TIMEOUT_MS = 8_000;
export const GROUP_OVER = 3;     // more new proposals than this → one grouped message
const GROUP_SHOWN = 10;          // a grouped message lists at most this many; the rest are "+N more proposals"
const TITLE_MAX = 120;
const LINE_MAX = 200;

export type ProposalNotifyDeps = {
  target: () => Promise<{ token: string; chatId: string } | null>;
  book: () => Promise<AliasBook>;
  siteUrl: () => string;
  autoRun: () => Promise<AutoRun>;
  send: (token: string, chatId: string, html: string, keyboard?: InlineKeyboard) => Promise<SendResult>;
  record: (r: SendResult, now: Date) => Promise<void>;
  lang: () => Promise<NotifyLang>;
  buttons?: () => Promise<((p: Proposal) => InlineKeyboard) | null>; // slice 7; null → no buttons
  // Owner 19 Oct: Discord gets a plain history of the same events (no buttons, no approve link).
  discord: () => Promise<{ url: string } | null>;
  sendDiscord: (url: string, content: string) => Promise<SendResult>;
  recordDiscord: (r: SendResult, now: Date) => Promise<void>;
  discordLang: () => Promise<NotifyLang>;
};

const DEPS: ProposalNotifyDeps = {
  target: telegramTarget,
  book: () => aliasBook(),
  siteUrl: () => serverEnv().SITE_URL,
  autoRun: () => readAutoRun(),
  send: (token, chatId, html, keyboard) => sendTelegram(token, chatId, html, keyboard ? { replyMarkup: keyboard } : {}),
  record: (r, now) => recordResult("telegram", r, now),
  lang: () => readNotifyLang("telegram"),
  discord: () => discordTarget(),
  sendDiscord: (url, content) => sendDiscord(url, content, { timeoutMs: HISTORY_TIMEOUT_MS }),
  recordDiscord: (r, now) => recordResult("discord", r, now),
  discordLang: () => readNotifyLang("discord"),
  // Loaded on use: telegram-approvals imports this file (proposalMessage).
  buttons: () => import("./telegram-approvals").then((m) => m.approvalButtons()),
};
type Out = string | { text: string; keyboard: InlineKeyboard };

const MSG = {
  en: {
    pending: "Status: ⏳ waiting", dev: "🧑‍💻 Dev is checking the code", proposer: ACTIONS_COPY.notifyFallback.en, app: "app",
    safe: "safe", risky: "needs care", proposes: "proposes", why: "Why", risk: "Risk", open: "Open in Auto-actions",
    waitingN: "new proposals waiting for approval:", moreN: "more proposals", automatic: "Automatic",
    rollbackWhy: "the app errored after the new deploy", succeeded: "Succeeded", failed: "Failed", stopFallback: "something failed",
  },
  id: {
    pending: "Status: ⏳ menunggu", dev: "🧑‍💻 Dev lagi cek kodenya", proposer: ACTIONS_COPY.notifyFallback.id, app: "aplikasi",
    safe: "aman", risky: "perlu hati-hati", proposes: "usul", why: "Kenapa", risk: "Risiko", open: "Buka di Auto-actions",
    waitingN: "usulan baru menunggu persetujuan:", moreN: "usulan lagi", automatic: "Otomatis",
    rollbackWhy: "app-nya error setelah deploy baru", succeeded: "Berhasil", failed: "Gagal", stopFallback: "ada yang gagal",
  },
};
// The action names in an Indonesian notice (the web UI keeps ACTIONS[...].label in English).
const ACTION_LABEL_ID: Record<ProposalAction, string> = {
  recheck: "Cek ulang sekarang", neon_wake: "Bangunin Neon", supabase_keepalive: "Kirim keep-alive Supabase",
  supabase_restore: "Restore project Supabase", vercel_redeploy: "Redeploy production", vercel_rollback: "Rollback ke deploy sebelumnya",
  github_bump_pr: "Bikin PR update paket", domain_recheck: "Cek ulang sertifikat domain", daily_rerun: "Jalanin ulang daily job",
};
export const pendingLine = (lang: NotifyLang = "en"): string => t(MSG, lang, "pending");
export const devLine = (lang: NotifyLang = "en"): string => t(MSG, lang, "dev");
const label = (p: Proposal, lang: NotifyLang) => (lang === "id" ? ACTION_LABEL_ID[p.action] : undefined) ?? ACTIONS[p.action]?.label ?? p.actionLabel;
const riskText = (p: Proposal, lang: NotifyLang) => t(MSG, lang, p.risk === "risky" || ACTIONS[p.action]?.risk === "risky" ? "risky" : "safe");
export const actionsUrl = (siteUrl: string, id?: string): string => `${siteUrl.replace(/\/+$/, "")}/auto-actions${id ? `?proposal=${encodeURIComponent(id)}` : ""}`;

// Pure: one proposal's notice.
// `dev`: the Dev officer was asked to read the code for it (slice 3, LogErrorSpike): one extra line.
export function proposalMessage(p: Proposal, book: AliasBook, siteUrl: string, dev = false, lang: NotifyLang = "en"): string {
  const m = (k: keyof typeof MSG.en) => t(MSG, lang, k);
  const who = cleanLine(p.proposedBy, book, 60) || m("proposer");
  const title = cleanLine(p.title, book, TITLE_MAX);
  const reason = cleanLine(p.reason, book, LINE_MAX) || "-";
  return [
    `🧑‍✈️ ${esc(who)} ${m("proposes")}: ${esc(label(p, lang))} — ${esc(title)}`,
    `${m("why")}: ${esc(reason)}`,
    `${m("risk")}: ${riskText(p, lang)}`,
    ...(dev ? [devLine(lang)] : []),
    `${m("open")}: ${esc(actionsUrl(siteUrl, p.id))}`,
  ].join("\n");
}

// Pure: more than GROUP_OVER new proposals in one message (at most GROUP_SHOWN listed, each with its own link).
export function proposalsGroupMessage(list: Proposal[], book: AliasBook, siteUrl: string, dev: ReadonlySet<string> = new Set(), lang: NotifyLang = "en"): string {
  const m = (k: keyof typeof MSG.en) => t(MSG, lang, k);
  const shown = list.slice(0, GROUP_SHOWN).map((p) => {
    const who = cleanLine(p.proposedBy, book, 60) || m("proposer");
    return `• ${esc(who)}: ${esc(label(p, lang))} — ${esc(cleanLine(p.title, book, TITLE_MAX))} (${riskText(p, lang)})${dev.has(p.id) ? ` · ${devLine(lang)}` : ""}\n  ${esc(actionsUrl(siteUrl, p.id))}`;
  });
  const more = list.length > GROUP_SHOWN ? [`+${list.length - GROUP_SHOWN} ${m("moreN")}`] : [];
  return [
    `🧑‍✈️ ${list.length} ${m("waitingN")}`,
    ...shown, ...more,
    `${m("open")}: ${esc(actionsUrl(siteUrl))}`,
  ].join("\n");
}

// Pure: the one-line notice after an auto-run proposal finished, or null when there is nothing to say.
export function proposalResultMessage(p: Proposal, book: AliasBook, lang: NotifyLang = "en"): string | null {
  if (!p.auto || (p.status !== "done" && p.status !== "failed")) return null;
  const icon = p.status === "done" ? "✅" : "❌";
  const result = p.result ? cleanLine(p.result, book, LINE_MAX) : "";
  return `${icon} ${t(MSG, lang, "automatic")}: ${esc(label(p, lang))} — ${esc(cleanLine(p.title, book, TITLE_MAX))}${result ? `: ${esc(result)}` : ""}`;
}

// Pure: which of these need the owner's attention: pending, not auto, and risky or a safe kind not switched on.
export function needsOwner(p: Proposal, autoRun: AutoRun): boolean {
  if (p.status !== "pending" || p.auto) return false;
  return ACTIONS[p.action]?.risk !== "safe" || p.risk === "risky" || !autoRun[p.action];
}

// ---- Discord history (owner 19 Oct: "approve ke telegram aja, di discord cuman kayak riwayat aja") ----
// One plain line per event: proposed, approved / rejected, ran / failed. No buttons, no approve link, same scrub as the
// Telegram notices; Discord markdown characters are dropped like compose.ts does. Sent only while the Discord channel is
// on, whether or not Telegram is connected; a Discord failure is recorded on the channel and never blocks anything.
export type HistoryEvent = "proposed" | "approved" | "rejected" | "done" | "failed";
// History is the least important message: a short budget (fetch and whole send), so it can never hold anything up for long.
export const HISTORY_TIMEOUT_MS = 3_000;

const HIST = {
  en: {
    proposed: "📝 Proposed", approved: "✅ Approved by the owner", rejected: "🚫 Rejected by the owner", done: "⚙️ Ran", failed: "❌ Failed",
    waiting: "waiting for approval on Telegram.", newN: "new proposals",
  },
  id: {
    proposed: "📝 Usulan", approved: "✅ Disetujui owner", rejected: "🚫 Ditolak owner", done: "⚙️ Dijalankan", failed: "❌ Gagal",
    waiting: "nunggu persetujuan di Telegram.", newN: "usulan baru",
  },
};
const mdOff = (s: string) => s.replace(/[*_`~|\[\]<>]/g, "");

// Pure. A list of (new) proposals gives the one grouped line ("N new proposals — …").
export function historyLine(event: HistoryEvent, p: Proposal | readonly Proposal[], book: AliasBook, lang: NotifyLang = "en"): string {
  const m = (k: keyof typeof HIST.en) => t(HIST, lang, k);
  if (Array.isArray(p)) return `📝 ${p.length} ${m("newN")} — ${m("waiting")}`;
  const one = p as Proposal;
  const title = mdOff(cleanLine(one.title, book, TITLE_MAX) || label(one, lang));
  if (event === "proposed") return `${m("proposed")}: ${title} — ${m("waiting")}`;
  if (event === "approved" || event === "rejected") return `${m(event)}: ${title}`;
  const result = one.result ? mdOff(cleanLine(one.result, book, LINE_MAX)) : "";
  return `${m(event)}: ${title}${result ? ` — ${result}` : ""}`;
}

async function sendHistory(build: (book: AliasBook, lang: NotifyLang) => string[], d: ProposalNotifyDeps, now: Date): Promise<void> {
  try {
    const target = await d.discord();
    if (!target) return;
    const book = await d.book().catch(() => EMPTY_BOOK);
    const lang = await d.discordLang().catch(() => "en" as const);
    const lines = build(book, lang);
    if (!lines.length) return;
    let res: SendResult;
    try {
      res = await d.sendDiscord(target.url, lines.join("\n"));
    } catch {
      res = { ok: false, kind: "transient", error: "Discord didn't answer." };
    }
    await d.recordDiscord(res, now).catch(() => console.warn(`${ACTIONS_COPY.logTag}/discord: recording the result failed`));
  } catch {
    console.warn(`${ACTIONS_COPY.logTag}/discord: sending the action history failed`);
  }
}

// One event for one proposal (the decide path and the auto-run results call this). Never throws.
export async function notifyHistory(event: HistoryEvent, p: Proposal, deps: Partial<ProposalNotifyDeps> = {}, opts: Opts = {}): Promise<void> {
  const d = { ...DEPS, ...deps };
  await guarded(() => sendHistory((book, lang) => [historyLine(event, p, book, lang)], d, opts.now ?? new Date()), opts.timeoutMs ?? HISTORY_TIMEOUT_MS);
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { t = setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

async function sendAll(build: (book: AliasBook, lang: NotifyLang) => Promise<Out[]> | Out[], d: ProposalNotifyDeps, now: Date): Promise<void> {
  const target = await d.target();
  if (!target) return;
  const book = await d.book().catch(() => EMPTY_BOOK);
  const lang = await d.lang().catch(() => "en" as const);
  for (const out of await build(book, lang)) {
    let res: SendResult;
    try {
      res = typeof out === "string" ? await d.send(target.token, target.chatId, out) : await d.send(target.token, target.chatId, out.text, out.keyboard);
    } catch {
      res = { ok: false, kind: "transient", error: "Telegram didn't answer." };
    }
    await d.record(res, now).catch(() => console.warn(`${ACTIONS_COPY.logTag}/telegram: recording the result failed`));
  }
}

async function guarded(job: () => Promise<void>, timeoutMs: number): Promise<void> {
  try {
    await within(job(), timeoutMs);
  } catch (e) {
    console.warn(`${ACTIONS_COPY.logTag}/telegram: sending the proposal notice failed:`, e instanceof Error ? e.name : "error");
  }
}

type Opts = { now?: Date; timeoutMs?: number; devQueued?: ReadonlySet<string> };

// New proposals (just created): one message each for those that need the owner, or one grouped message when there are
// more than GROUP_OVER. Auto-run ones send nothing here (notifyProposalResult tells when they finish).
export async function notifyNewProposals(proposals: Proposal[], deps: Partial<ProposalNotifyDeps> = {}, opts: Opts = {}): Promise<void> {
  if (!proposals.length) return;
  const d = { ...DEPS, ...deps };
  await guarded(async () => {
    const autoRun = await d.autoRun().catch(() => null);
    // Can't read the setting: treat every safe kind as off, so nothing is silently skipped.
    const list = proposals.filter((p) => needsOwner(p, autoRun ?? ({} as AutoRun)));
    if (!list.length) return;
    const keyboard = list.length > GROUP_OVER || !d.buttons ? null : await d.buttons().catch(() => null);
    const now = opts.now ?? new Date();
    await Promise.all([
      sendAll((book, lang) => (list.length > GROUP_OVER
        ? [proposalsGroupMessage(list, book, d.siteUrl(), opts.devQueued, lang)]
        : list.map((p) => {
          const text = proposalMessage(p, book, d.siteUrl(), opts.devQueued?.has(p.id) ?? false, lang);
          return keyboard ? { text: `${text}\n${pendingLine(lang)}`, keyboard: keyboard(p) } : text;
        })), d, now),
      sendHistory((book, lang) => (list.length > GROUP_OVER ? [historyLine("proposed", list, book, lang)] : list.map((p) => historyLine("proposed", p, book, lang))), d, now),
    ]);
  }, opts.timeoutMs ?? NOTIFY_TIMEOUT_MS);
}

// An auto-run proposal that finished (done / failed): one line. Anything else sends nothing.
export async function notifyProposalResult(p: Proposal, deps: Partial<ProposalNotifyDeps> = {}, opts: Opts = {}): Promise<void> {
  if (!p.auto || (p.status !== "done" && p.status !== "failed")) return;
  const d = { ...DEPS, ...deps };
  const now = opts.now ?? new Date();
  await guarded(() => Promise.all([
    sendAll((book, lang) => {
      const text = proposalResultMessage(p, book, lang);
      return text ? [text] : [];
    }, d, now),
    sendHistory((book, lang) => [historyLine(p.status === "done" ? "done" : "failed", p, book, lang)], d, now),
  ]).then(() => undefined), opts.timeoutMs ?? NOTIFY_TIMEOUT_MS);
}

// Auto-rollback after a bad production deploy (owner 16 Oct). Pure: the notice after an automatic rollback ran (done or
// failed): what happened, why, which deploy went back, what to do, and the result line.
export function autoRollbackMessage(p: Proposal, info: { reason: string; newRef: string }, book: AliasBook, lang: NotifyLang = "en"): string {
  const m = (k: keyof typeof MSG.en) => t(MSG, lang, k);
  const app = cleanLine(p.resourceName ?? m("app"), book, 60) || m("app");
  const reason = cleanLine(info.reason, book, LINE_MAX).replace(/[.!?…]+$/, "") || m("rollbackWhy");
  const result = p.result ? cleanLine(p.result, book, LINE_MAX) : "";
  return [
    lang === "id"
      ? `⏪ Otomatis rollback ${esc(app)}: ${esc(reason)}. Deploy baru ${esc(cleanLine(info.newRef, book, 40))} dibalikin ke deploy sebelumnya. Benerin dulu, terus deploy ulang.`
      : `⏪ Automatic rollback of ${esc(app)}: ${esc(reason)}. The new deploy ${esc(cleanLine(info.newRef, book, 40))} was rolled back to the previous one. Fix it first, then deploy again.`,
    `${p.status === "done" ? "✅" : "❌"} ${p.status === "done" ? m("succeeded") : m("failed")}${result ? `: ${esc(result)}` : ""}`,
  ].join("\n");
}

export async function notifyAutoRollback(p: Proposal, info: { reason: string; newRef: string }, deps: Partial<ProposalNotifyDeps> = {}, opts: Opts = {}): Promise<void> {
  if (p.status !== "done" && p.status !== "failed") return;
  const d = { ...DEPS, ...deps };
  const now = opts.now ?? new Date();
  await guarded(() => Promise.all([
    sendAll((book, lang) => [autoRollbackMessage(p, info, book, lang)], d, now),
    sendHistory((book, lang) => [historyLine(p.status === "done" ? "done" : "failed", p, book, lang)], d, now),
  ]).then(() => undefined), opts.timeoutMs ?? NOTIFY_TIMEOUT_MS);
}

// Automatic security fixes (owner 16 Oct). Pure: the one line when Watchbell's update PR is merged or stops.
export type DepPrNotice = { kind: "merged" | "stopped" | "ready-manual"; app: string; number: number; packages: string[]; reason?: string | null; windowMin?: number };

export function depPrMessage(n: DepPrNotice, book: AliasBook, lang: NotifyLang = "en"): string {
  const id = lang === "id";
  const app = cleanLine(n.app, book, 60) || t(MSG, lang, "app");
  const pkgs = n.packages.slice(0, 4).join(", ") + (n.packages.length > 4 ? `, +${n.packages.length - 4}` : "");
  if (n.kind === "merged") {
    return id
      ? `✅ PR #${n.number} di ${esc(app)} di-merge otomatis (${esc(pkgs)}). Deploy production jalan lewat Vercel; auto-rollback jaga ${n.windowMin ?? 30} menit pertama.`
      : `✅ PR #${n.number} in ${esc(app)} was merged automatically (${esc(pkgs)}). The production deploy runs through Vercel; auto-rollback watches the first ${n.windowMin ?? 30} minutes.`;
  }
  if (n.kind === "ready-manual") {
    return id
      ? `🔐 PR #${n.number} di ${esc(app)} siap di-merge, tapi auto-rollback mati — merge manual ya.`
      : `🔐 PR #${n.number} in ${esc(app)} is ready to merge, but auto-rollback is off — please merge it manually.`;
  }
  const reason = cleanLine(n.reason ?? "", book, LINE_MAX) || t(MSG, lang, "stopFallback");
  return id
    ? `⚠️ PR #${n.number} di ${esc(app)} butuh dicek: ${esc(reason)}. PR-nya dibiarin terbuka.`
    : `⚠️ PR #${n.number} in ${esc(app)} needs a look: ${esc(reason)}. The PR was left open.`;
}

export async function notifyDepPr(n: DepPrNotice, deps: Partial<ProposalNotifyDeps> = {}, opts: Opts = {}): Promise<void> {
  const d = { ...DEPS, ...deps };
  await guarded(() => sendAll((book, lang) => [depPrMessage(n, book, lang)], d, opts.now ?? new Date()), opts.timeoutMs ?? NOTIFY_TIMEOUT_MS);
}
