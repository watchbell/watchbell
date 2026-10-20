import "server-only";
import { type CallbackCode, checkCallback, openTicket } from "@/lib/backup/connect";
import type { DriveEnv } from "@/lib/backup/google-oauth";
import { seal } from "@/lib/crypto";
import { createRedirectUri, exchangeCreateCode } from "./google-connect";

// Stage 6 create requests, Firebase: what /auth/google/create/callback does once it knows the Owner (aal2) and has read
// (and cleared) the ticket cookie. Same checks as the Drive connect (lib/backup/callback.ts): the sealed ticket's state,
// expiry and member, then the code exchange with the cloud-platform scope check. The refresh token is sealed at once.
export type CreateCallbackDeps = {
  env: DriveEnv | null;
  keyB64: string;
  siteUrl: string;
  save: (sealed: { ciphertext: string; iv: string; keyVersion: number }) => Promise<void>;
  audit: (e: { kind: "ok" | "err"; message: string; detail?: string }) => Promise<void>;
  fetch?: typeof fetch;
  now?: number;
};

export async function finishCreateConnect(
  p: { cookie: string | undefined; state: string | null; code: string | null; error: string | null; memberId: string }, deps: CreateCallbackDeps,
): Promise<CallbackCode> {
  if (!deps.env) return "env";
  const check = checkCallback({
    ticket: openTicket(p.cookie, deps.keyB64), state: p.state, code: p.code, error: p.error, memberId: p.memberId, now: deps.now ?? Date.now(),
  });
  if (!check.ok) return check.reason;
  const r = await exchangeCreateCode(deps.env, { code: check.code, verifier: check.verifier, redirectUri: createRedirectUri(deps.siteUrl) }, { fetch: deps.fetch });
  if (!r.ok) {
    await deps.audit({ kind: "err", message: "Google (create projects) connect failed", detail: r.error }).catch(() => undefined);
    return r.kind === "scope" ? "scope" : r.kind === "transient" ? "failed" : "refused";
  }
  await deps.save(seal(r.refreshToken, deps.keyB64));
  await deps.audit({ kind: "ok", message: "Google (create projects) connected" }).catch(() => undefined);
  return "connected";
}
