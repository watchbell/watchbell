import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { members, settings } from "@/db/schema";
import { open as openSealed, type Sealed, seal } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { hashLinkCode, LINK_CODE_LENGTH, newLinkCode, type TelegramOwner } from "@/lib/notify/telegram-bot";

// Stage 9 slice 7: the Telegram webhook's state, in ops.settings (no new table). Every identifying value is sealed with
// OPS_ENCRYPTION_KEY like a channel's config: the webhook secret, the owner's Telegram user id and the chats the bot has
// seen. The /link code is stored only as a hash, for 10 minutes, and dies after 5 wrong tries.
export const WEBHOOK_KEY = "telegram.webhook";   // { sealed: secret, at }
export const OWNER_KEY = "telegram.owner";       // { sealed: { tg, member }, at }
export const LINK_KEY = "telegram.linkCode";     // { hash, member, expiresAt, tries }
export const SEEN_KEY = "telegram.seenChats";    // { sealed: [{ id, label, at }] }

export const POLL_OFFSET_KEY = "telegram.pollOffset"; // { offset } selfhost long polling: last update_id + 1

export const LINK_TTL_MS = 10 * 60_000;
export const LINK_MAX_TRIES = 5;
export const SEEN_MAX = 10;
const SECRET_MEMO_MS = 30_000;

type SealedValue = { sealed: Pick<Sealed, "ciphertext" | "iv" | "keyVersion">; at?: string };
const key = () => serverEnv().OPS_ENCRYPTION_KEY;

async function read(k: string): Promise<unknown> {
  const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, k)).limit(1);
  return row?.value ?? null;
}
async function write(k: string, value: Record<string, unknown>): Promise<void> {
  await db().insert(settings).values({ key: k, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}
async function remove(k: string): Promise<void> {
  await db().delete(settings).where(eq(settings.key, k));
}
function unseal(v: unknown): string | null {
  const s = (v as SealedValue | null)?.sealed;
  if (!s || typeof s.ciphertext !== "string" || typeof s.iv !== "string") return null;
  try {
    return openSealed(s, key());
  } catch {
    return null;
  }
}
const sealValue = (plain: string, now: Date): SealedValue => ({ sealed: seal(plain, key()), at: now.toISOString() });

// ---- the webhook secret (its presence = the approval buttons are on) ----
let memo: { secret: string | null; until: number } | null = null;

export async function webhookSecret(nowMs = Date.now()): Promise<string | null> {
  if (memo && memo.until > nowMs) return memo.secret;
  const secret = unseal(await read(WEBHOOK_KEY));
  memo = { secret, until: nowMs + SECRET_MEMO_MS };
  return secret;
}
export async function saveWebhookSecret(secret: string, now: Date): Promise<void> {
  await write(WEBHOOK_KEY, sealValue(secret, now));
  memo = null;
}
export async function clearWebhookSecret(): Promise<void> {
  await remove(WEBHOOK_KEY);
  memo = null;
}
export const webhookOn = async (): Promise<boolean> => (await webhookSecret()) !== null;
export function forgetWebhookMemo(): void {
  memo = null;
}

// ---- the owner's Telegram account ----
// The linked owner, but only while that member still exists and is still an owner.
export async function linkedOwner(): Promise<(TelegramOwner & { telegramUserId: string }) | null> {
  const plain = unseal(await read(OWNER_KEY));
  if (!plain) return null;
  let v: { tg?: unknown; member?: unknown };
  try {
    v = JSON.parse(plain);
  } catch {
    return null;
  }
  if (typeof v.tg !== "string" || typeof v.member !== "string") return null;
  const [m] = await db().select({ id: members.id, userId: members.userId }).from(members).where(and(eq(members.id, v.member), eq(members.role, "owner"))).limit(1);
  return m ? { telegramUserId: v.tg, memberId: m.id, userId: m.userId } : null;
}
export const ownerLinked = async (): Promise<boolean> => (await linkedOwner()) !== null;

// A fresh one-time code for this owner (replaces any earlier one). The plain code goes to the owner's screen only.
export async function createLinkCode(memberId: string, now: Date): Promise<{ code: string; expiresAt: Date }> {
  const code = newLinkCode();
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS);
  await write(LINK_KEY, { hash: hashLinkCode(code), member: memberId, expiresAt: expiresAt.toISOString(), tries: 0 });
  return { code, expiresAt };
}

export type LinkOutcome = "linked" | "wrong" | "expired";

// /link CODE from the connected chat: a match stores this Telegram user as the owner and spends the code.
export async function redeemLinkCode(code: string, telegramUserId: string, now: Date): Promise<LinkOutcome> {
  const v = (await read(LINK_KEY)) as { hash?: unknown; member?: unknown; expiresAt?: unknown; tries?: unknown } | null;
  if (!v || typeof v.hash !== "string" || typeof v.member !== "string" || typeof v.expiresAt !== "string") return "expired";
  if (Date.parse(v.expiresAt) <= now.getTime()) {
    await remove(LINK_KEY);
    return "expired";
  }
  const tries = typeof v.tries === "number" ? v.tries : 0;
  const given = code.length === LINK_CODE_LENGTH ? hashLinkCode(code) : "";
  if (!timingEqualHex(given, v.hash)) {
    if (tries + 1 >= LINK_MAX_TRIES) await remove(LINK_KEY);
    else await write(LINK_KEY, { ...v, tries: tries + 1 });
    return "wrong";
  }
  // The code's owner must still be an owner.
  const [m] = await db().select({ id: members.id }).from(members).where(and(eq(members.id, v.member), eq(members.role, "owner"))).limit(1);
  await remove(LINK_KEY);
  if (!m) return "expired";
  await write(OWNER_KEY, sealValue(JSON.stringify({ tg: telegramUserId, member: m.id }), now));
  return "linked";
}

function timingEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || !a) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- the chats the webhook has seen (Find chats while the webhook is on) ----
export type SeenChat = { id: string; label: string; at: string };

export async function readSeenChats(): Promise<SeenChat[]> {
  const plain = unseal(await read(SEEN_KEY));
  if (!plain) return [];
  try {
    const list = JSON.parse(plain) as unknown;
    return Array.isArray(list)
      ? list.filter((c): c is SeenChat => !!c && typeof c.id === "string" && typeof c.label === "string" && typeof c.at === "string").slice(0, SEEN_MAX)
      : [];
  } catch {
    return [];
  }
}

// Pure: the list after seeing `chat` now (newest first, at most SEEN_MAX), or null when nothing worth a write changed
// (same chat, same label, seen within the hour).
export function nextSeen(list: SeenChat[], chat: { id: string; label: string }, now: Date): SeenChat[] | null {
  const had = list.find((c) => c.id === chat.id);
  if (had && had.label === chat.label && now.getTime() - Date.parse(had.at) < 3_600_000 && list[0]?.id === chat.id) return null;
  return [{ id: chat.id, label: chat.label, at: now.toISOString() }, ...list.filter((c) => c.id !== chat.id)].slice(0, SEEN_MAX);
}

export async function recordSeenChat(chat: { id: string; label: string }, now: Date): Promise<void> {
  const next = nextSeen(await readSeenChats(), chat, now);
  if (next) await write(SEEN_KEY, sealValue(JSON.stringify(next), now));
}

export const clearSeenChats = (): Promise<void> => remove(SEEN_KEY);

// ---- selfhost long polling: where getUpdates resumes ----
export async function readPollOffset(): Promise<number> {
  const n = ((await read(POLL_OFFSET_KEY)) as { offset?: unknown } | null)?.offset;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
}
export const writePollOffset = (offset: number): Promise<void> => write(POLL_OFFSET_KEY, { offset });
