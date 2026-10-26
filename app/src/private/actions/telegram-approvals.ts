import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { esc } from "@/lib/alerts/compose";
import { ACTIONS_COPY } from "@/lib/copy/edition";
import { recordAction } from "@/lib/data/audit-db";
import { readAliasBook } from "@/lib/data/aliases-db";
import { ownerLinked, webhookOn } from "@/lib/data/telegram-bot-db";
import { serverEnv } from "@/lib/env";
import { type NotifyLang, readNotifyLang } from "@/lib/notify/lang";
import type { BotClient, InlineKeyboard, TelegramCallback, TelegramOwner } from "@/lib/notify/telegram-bot";
import { type AliasBook, EMPTY_BOOK } from "@/lib/view/display-name";
import { actionProposals } from "@/private/db/schema";
import { ownerLine } from "@/private/console/clean-text";
import { toProposal } from "./proposals";
import { decideAndRun } from "./proposals-decide";
import { proposalMessage } from "./proposals-notify";
import { ACTIONS, type Proposal } from "./proposals-types";

// Stage 9 slice 7: approve or reject an officer's proposal from its Telegram notice. The notice carries two inline
// buttons, [✅ Approve] [❌ Reject]; each button's callback_data is "p:<id>:<op>[:<exp>]:<mac>", where mac is a short
// HMAC-SHA256 (keyed from OPS_ENCRYPTION_KEY) of everything before it, so a callback nobody signed decides nothing.
// The core webhook (lib/notify/telegram-updates.ts) has already checked the chat (the connected one) and the sender (the
// linked owner) before a tap reaches proposalCallback.
//   a  approve. A safe action runs at once; a risky one first turns the buttons into [⚠️ Sure? Approve] [Cancel] (c / x),
//      and only a tap on "Sure?" within CONFIRM_MS approves it.
//   r  reject.   c  confirmed approve (carries its expiry).   x  cancel the confirmation (back to the two buttons).
// Approving goes through decideAndRun, the office route's own path (decideProposal + executeProposal, the owner as the
// actor), and the message follows it: Status waiting → running → ✅ done / ❌ failed with the result; once decided the
// buttons are gone. A proposal already decided or expired answers "This proposal is already decided / expired".

export const CONFIRM_MS = 2 * 60_000;
const MAC_CHARS = 16; // 96 bits, base64url; the longest data ("p:<uuid>:c:<exp>:<mac>") stays under Telegram's 64 bytes
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Button labels and toasts, in the notification language (notify.language). callback_data never changes with it.
export const TEXT = {
  en: {
    approve: "✅ Approve", reject: "❌ Reject", sure: "⚠️ Sure? Approve", cancel: "Cancel",
    invalid: "This button is not valid.",
    gone: "This proposal is already decided / expired",
    confirmFirst: "This action is risky. Tap ⚠️ Sure? Approve within 2 minutes.",
    confirmLate: "The confirmation expired. Tap ✅ Approve again.",
    cancelled: "Cancelled. The proposal is still waiting.",
    running: "Approved. Running…",
    rejected: "Rejected.",
    failed: "Could not process it. Try again from Auto-actions.",
  },
  id: {
    approve: "✅ Setujui", reject: "❌ Tolak", sure: "⚠️ Yakin? Setujui", cancel: "Batal",
    invalid: "Tombol ini nggak valid.",
    gone: "Usulan ini udah diputuskan / kedaluwarsa",
    confirmFirst: "Aksi ini berisiko. Tap ⚠️ Yakin? Setujui dalam 2 menit.",
    confirmLate: "Konfirmasinya kedaluwarsa. Tap ✅ Setujui lagi.",
    cancelled: "Dibatalkan. Usulannya masih menunggu.",
    running: "Disetujui. Lagi jalan…",
    rejected: "Ditolak.",
    failed: "Gagal memproses. Coba lagi dari Auto-actions.",
  },
} as const;

// ---- callback data (pure) ----
export type CallbackOp = "a" | "r" | "c" | "x";
export type ParsedCallback = { id: string; op: CallbackOp; exp: number | null };

export const callbackKey = (opsKeyB64: string): Buffer =>
  createHmac("sha256", Buffer.from(opsKeyB64, "base64")).update("watchpost:telegram-callback:v1").digest();

const mac = (key: Buffer, payload: string) => createHmac("sha256", key).update(payload, "utf8").digest("base64url").slice(0, MAC_CHARS);

export function signCallback(key: Buffer, id: string, op: CallbackOp, exp: number | null = null): string {
  const payload = `p:${id}:${op}${op === "c" ? `:${(exp ?? 0).toString(36)}` : ""}`;
  return `${payload}:${mac(key, payload)}`;
}

export function verifyCallback(key: Buffer, data: string): ParsedCallback | null {
  if (typeof data !== "string" || data.length > 64) return null;
  const cut = data.lastIndexOf(":");
  if (cut < 0) return null;
  const payload = data.slice(0, cut);
  const given = Buffer.from(data.slice(cut + 1), "utf8");
  const want = Buffer.from(mac(key, payload), "utf8");
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  const parts = payload.split(":");
  if (parts[0] !== "p" || !UUID.test(parts[1] ?? "")) return null;
  const op = parts[2] as CallbackOp;
  if (op === "c") {
    if (parts.length !== 4 || !/^[0-9a-z]{1,10}$/.test(parts[3])) return null;
    return { id: parts[1], op, exp: parseInt(parts[3], 36) };
  }
  if (parts.length !== 3 || !["a", "r", "x"].includes(op)) return null;
  return { id: parts[1], op, exp: null };
}

export const approvalKeyboard = (key: Buffer, id: string, lang: NotifyLang = "en"): InlineKeyboard => ({
  inline_keyboard: [[{ text: TEXT[lang].approve, callback_data: signCallback(key, id, "a") }, { text: TEXT[lang].reject, callback_data: signCallback(key, id, "r") }]],
});
// exp: epoch seconds.
export const confirmKeyboard = (key: Buffer, id: string, exp: number, lang: NotifyLang = "en"): InlineKeyboard => ({
  inline_keyboard: [[{ text: TEXT[lang].sure, callback_data: signCallback(key, id, "c", exp) }, { text: TEXT[lang].cancel, callback_data: signCallback(key, id, "x") }]],
});

// ---- the message (pure) ----
const STATUS: Record<NotifyLang, Record<Proposal["status"], string>> = {
  en: { pending: "⏳ waiting", approved: "⚙️ running", running: "⚙️ running", done: "✅ done", failed: "❌ failed", rejected: "🚫 rejected", expired: "⌛ expired" },
  id: { pending: "⏳ menunggu", approved: "⚙️ jalan", running: "⚙️ jalan", done: "✅ selesai", failed: "❌ gagal", rejected: "🚫 ditolak", expired: "⌛ kedaluwarsa" },
};

export function statusLine(p: Proposal, book: AliasBook, lang: NotifyLang = "en"): string {
  const result = p.result && (p.status === "done" || p.status === "failed" || p.status === "expired") ? ownerLine(p.result, book, 200) : "";
  return `Status: ${STATUS[lang][p.status]}${result ? ` — ${esc(result)}` : ""}`;
}

export const noticeText = (p: Proposal, book: AliasBook, siteUrl: string, lang: NotifyLang = "en"): string =>
  `${proposalMessage(p, book, siteUrl, false, lang)}\n${statusLine(p, book, lang)}`;

const isRisky = (p: Proposal) => p.risk === "risky" || ACTIONS[p.action]?.risk === "risky";
const open = (p: Proposal, now: Date) => p.status === "pending" && Date.parse(p.expiresAt) > now.getTime();

// ---- the tap ----
export type ApprovalDeps = {
  key: () => Buffer;
  get: (id: string) => Promise<Proposal | null>;
  decide: typeof decideAndRun;
  book: () => Promise<AliasBook>;
  siteUrl: () => string;
  lang: () => Promise<NotifyLang>;
  audit: (e: { kind: "ok" | "err"; message: string; actorUserId: string }) => Promise<void>;
};

async function getProposal(id: string): Promise<Proposal | null> {
  const [row] = await db().select({
    id: actionProposals.id, room: actionProposals.room, action: actionProposals.action, risk: actionProposals.risk, title: actionProposals.title,
    reason: actionProposals.reason, resourceName: actionProposals.resourceName, proposedBy: actionProposals.proposedBy, status: actionProposals.status,
    auto: actionProposals.auto, result: actionProposals.result, createdAt: actionProposals.createdAt, decidedAt: actionProposals.decidedAt,
    expiresAt: actionProposals.expiresAt,
  }).from(actionProposals).where(eq(actionProposals.id, id)).limit(1);
  return row ? toProposal(row) : null;
}

const DEPS: ApprovalDeps = {
  key: () => callbackKey(serverEnv().OPS_ENCRYPTION_KEY),
  get: getProposal,
  decide: decideAndRun,
  book: () => readAliasBook(),
  siteUrl: () => serverEnv().SITE_URL,
  lang: () => readNotifyLang("telegram"),
  audit: (e) => recordAction({ ...e, resourceId: null }),
};

export async function proposalCallback(
  q: TelegramCallback, ctx: { client: BotClient; owner: TelegramOwner; now: Date }, deps: ApprovalDeps = DEPS,
): Promise<void> {
  const { client, owner, now } = ctx;
  const key = deps.key();
  const lang = await deps.lang().catch(() => "en" as const);
  const T = TEXT[lang];
  const parsed = verifyCallback(key, q.data);
  if (!parsed) {
    await client.answer(q.queryId, T.invalid);
    return;
  }
  let bookP: Promise<AliasBook> | null = null;
  const book = () => (bookP ??= deps.book().catch(() => EMPTY_BOOK));
  const show = async (p: Proposal, keyboard: InlineKeyboard | null) => client.editText(q.chatId, q.messageId, noticeText(p, await book(), deps.siteUrl(), lang), keyboard);
  const gone = async (p: Proposal | null) => {
    await client.answer(q.queryId, T.gone);
    if (p) await show(p, null);
    else await client.editKeyboard(q.chatId, q.messageId, { inline_keyboard: [] });
  };

  const p = await deps.get(parsed.id);
  if (!p || !open(p, now)) return gone(p);

  if (parsed.op === "x") {
    await client.editKeyboard(q.chatId, q.messageId, approvalKeyboard(key, p.id, lang));
    await client.answer(q.queryId, T.cancelled);
    return;
  }
  if (parsed.op === "a" && isRisky(p)) {
    await client.editKeyboard(q.chatId, q.messageId, confirmKeyboard(key, p.id, Math.floor((now.getTime() + CONFIRM_MS) / 1000), lang));
    await client.answer(q.queryId, T.confirmFirst);
    return;
  }
  if (parsed.op === "c" && (parsed.exp ?? 0) * 1000 < now.getTime()) {
    await client.editKeyboard(q.chatId, q.messageId, approvalKeyboard(key, p.id, lang));
    await client.answer(q.queryId, T.confirmLate);
    return;
  }

  const decision = parsed.op === "r" ? "reject" : "approve";
  let answered = false;
  try {
    const d = await deps.decide(p.id, decision, { id: owner.memberId, userId: owner.userId }, now, {
      // Approved: answer the tap at once and show "running" while the action runs.
      onApproved: async (approved) => {
        answered = true;
        await client.answer(q.queryId, T.running);
        await show(approved, null);
      },
    });
    if (d.status === "missing") return gone(null);
    if (d.status === "conflict") return gone(d.proposal);
    await deps.audit({ kind: "ok", message: ACTIONS_COPY.telegramDecided(decision === "approve" ? "approved" : "rejected", d.proposal.title.slice(0, 120)), actorUserId: owner.userId })
      .catch(() => console.warn("audit event failed"));
    if (!answered) await client.answer(q.queryId, decision === "reject" ? T.rejected : T.running);
    await show(d.proposal, null);
    await d.flushHistory?.(); // the Discord history goes out last: the owner has been answered and the audit is written
  } catch (e) {
    console.warn("telegram approvals: deciding failed:", e instanceof Error ? e.name : "error");
    if (!answered) await client.answer(q.queryId, T.failed);
  }
}

// ---- the notice's buttons (proposals-notify.ts) ----
// The keyboard builder while the buttons can work (webhook on and the owner linked), else null: then the notice keeps
// only its link to Auto-actions.
export async function approvalButtons(): Promise<((p: Proposal) => InlineKeyboard) | null> {
  if (!(await webhookOn()) || !(await ownerLinked())) return null;
  const key = callbackKey(serverEnv().OPS_ENCRYPTION_KEY);
  const lang = await readNotifyLang("telegram");
  return (p) => approvalKeyboard(key, p.id, lang);
}
