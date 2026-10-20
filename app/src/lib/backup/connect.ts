import "server-only";
import { ENV_COPY } from "@/lib/copy/edition";
import { open, seal } from "@/lib/crypto";
import { sameState } from "./google-oauth";

// B1: the Drive connect flow's short-lived "ticket": the state and the PKCE verifier, sealed with the console's key in an
// httpOnly cookie that only /auth/google/* receives, and bound to the member who started it.

export const OAUTH_COOKIE = "wp_drive_oauth";
export const OAUTH_COOKIE_PATH = "/auth/google";
export const OAUTH_TTL_S = 600;

export type OAuthTicket = { state: string; verifier: string; memberId: string; exp: number };

export function sealTicket(t: OAuthTicket, keyB64: string): string {
  const s = seal(JSON.stringify(t), keyB64);
  return Buffer.from(JSON.stringify({ iv: s.iv, c: s.ciphertext })).toString("base64url");
}

export function openTicket(raw: string | undefined | null, keyB64: string): OAuthTicket | null {
  if (!raw || raw.length > 4096) return null;
  try {
    const box = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { iv?: unknown; c?: unknown };
    if (typeof box.iv !== "string" || typeof box.c !== "string") return null;
    const t = JSON.parse(open({ iv: box.iv, ciphertext: box.c }, keyB64)) as Partial<OAuthTicket>;
    if (typeof t.state !== "string" || typeof t.verifier !== "string" || typeof t.memberId !== "string" || typeof t.exp !== "number") return null;
    return { state: t.state, verifier: t.verifier, memberId: t.memberId, exp: t.exp };
  } catch {
    return null;
  }
}

// The fixed result codes the callback puts in /backups?drive=…; Google's own text never reaches a URL or the page.
export const CALLBACK_CODES = ["connected", "denied", "expired", "state", "member", "missing", "refused", "scope", "env", "failed"] as const;
export type CallbackCode = (typeof CALLBACK_CODES)[number];

export const CALLBACK_TEXT: Record<CallbackCode, { tone: "ok" | "danger"; text: string }> = {
  connected: { tone: "ok", text: "Google Drive connected. Backups go to the console's backups folder in your Drive; the first backup makes one if there is none yet." },
  denied: { tone: "danger", text: "Google Drive wasn't connected: the permission was declined on Google's page." },
  expired: { tone: "danger", text: "The connect link expired (10 minutes). Start again from Connect Google Drive." },
  state: { tone: "danger", text: "That answer from Google didn't match the connect you started here, so it was ignored. Start again." },
  member: { tone: "danger", text: "The connect was started by another sign-in. Start again from this one." },
  missing: { tone: "danger", text: "Google didn't send an authorisation code. Start again." },
  refused: { tone: "danger", text: `Google refused the authorisation. Check the OAuth client ${ENV_COPY.checkWhere} and start again.` },
  scope: { tone: "danger", text: "The Drive permission wasn't granted, or Google sent no refresh token. Connect again and allow it." },
  env: { tone: "danger", text: ENV_COPY.notSet("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET", true) },
  failed: { tone: "danger", text: "Google Drive couldn't be connected. Try again in a minute." },
};

export const isCallbackCode = (v: string | null | undefined): v is CallbackCode => !!v && (CALLBACK_CODES as readonly string[]).includes(v);

export function checkCallback(p: {
  ticket: OAuthTicket | null; state: string | null; code: string | null; error: string | null; memberId: string; now: number;
}): { ok: true; code: string; verifier: string } | { ok: false; reason: CallbackCode } {
  // No ticket (cookie gone, never set, or unreadable): nothing proves this browser started a connect.
  if (!p.ticket) return { ok: false, reason: p.error ? "denied" : "expired" };
  if (p.now > p.ticket.exp) return { ok: false, reason: "expired" };
  if (!sameState(p.ticket.state, p.state)) return { ok: false, reason: "state" };
  if (p.ticket.memberId !== p.memberId) return { ok: false, reason: "member" };
  if (p.error) return { ok: false, reason: "denied" };
  if (!p.code || p.code.length > 2048) return { ok: false, reason: "missing" };
  return { ok: true, code: p.code, verifier: p.ticket.verifier };
}
