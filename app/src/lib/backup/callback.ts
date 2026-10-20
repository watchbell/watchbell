import "server-only";
import { seal } from "@/lib/crypto";
import { type CallbackCode, checkCallback, openTicket } from "./connect";
import { type DriveEnv, exchangeCode, redirectUri } from "./google-oauth";

// B1: what /auth/google/callback does once it knows the owner and has read (and cleared) the ticket cookie. Kept out of
// the route so it can be tested without Next.js. Returns the fixed code the route puts in /backups?drive=….
export type CallbackDeps = {
  env: DriveEnv | null;
  keyB64: string;
  siteUrl: string;
  save: (sealed: { ciphertext: string; iv: string; keyVersion: number }) => Promise<void>;
  audit: (e: { kind: "ok" | "err"; message: string; detail?: string }) => Promise<void>;
  fetch?: typeof fetch;
  now?: number;
};

export async function finishDriveConnect(
  p: { cookie: string | undefined; state: string | null; code: string | null; error: string | null; memberId: string }, deps: CallbackDeps,
): Promise<CallbackCode> {
  if (!deps.env) return "env";
  const check = checkCallback({
    ticket: openTicket(p.cookie, deps.keyB64), state: p.state, code: p.code, error: p.error, memberId: p.memberId, now: deps.now ?? Date.now(),
  });
  if (!check.ok) return check.reason;
  const r = await exchangeCode(deps.env, { code: check.code, verifier: check.verifier, redirectUri: redirectUri(deps.siteUrl) }, { fetch: deps.fetch });
  if (!r.ok) {
    await deps.audit({ kind: "err", message: "Google Drive connect failed", detail: r.error }).catch(() => undefined);
    return r.kind === "scope" || r.kind === "format" ? "scope" : r.kind === "transient" ? "failed" : "refused";
  }
  await deps.save(seal(r.refreshToken, deps.keyB64));
  await deps.audit({ kind: "ok", message: "Google Drive connected" }).catch(() => undefined);
  return "connected";
}
