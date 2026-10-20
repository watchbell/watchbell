"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { authProvider, type SessionUser } from "@/lib/auth-provider";
import { serverEnv } from "@/lib/env";
import { acceptLocalCode, startLocalEnrollment } from "@/lib/local-auth/mfa";
import { SESSION_COOKIE, setSessionCookie } from "@/lib/local-auth/session-cookie";
import { replaceLocalSession } from "@/lib/local-auth/sessions-db";
import { isDemo, mode } from "@/lib/mode";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { createClient } from "@/lib/supabase/server";

// "done": the session is now aal2. The form reloads the page instead of a router redirect, because the
// client router still holds pages it fetched while the session was aal1 (they redirect back to /mfa).
// `next` (self-host only): where that reload goes instead of "/" (the forced password change).
export type MfaFormState = { status: "idle" } | { status: "done"; next?: string } | { status: "error"; message: string };
export type Enrollment = { ok: true; factorId: string; qr: string; secret: string } | { ok: false; error: string };

// The demo has no authenticator step (its session is already aal2); these never fall through to Supabase.
const NO_MFA_IN_DEMO = "Two-step sign-in isn't used in the demo.";

const BAD_CODE: MfaFormState = { status: "error", message: "That code didn't work. Check the 6 digits in your authenticator app and try again." };

async function sessionOrSignIn() {
  const session = await getSessionUser();
  if (!session) redirect("/signin");
  return session;
}

async function underLimit(userId: string): Promise<MfaFormState | null> {
  const d = await limit(LIMITS.mfaCode, userId);
  return d.allowed ? null : { status: "error", message: `Too many codes tried. Try again in ${minutesText(d.retryAfter)}.` };
}

// Self-host: a code was accepted. The aal1 token ends and a new aal2 one replaces it in the cookie.
// The session read at the start of the action already says whether the password must still change.
async function finishLocal(session: SessionUser, purpose: "confirm" | "verify", code: string): Promise<MfaFormState> {
  const { userId } = session;
  if (!(await acceptLocalCode(userId, code, purpose, serverEnv().OPS_ENCRYPTION_KEY))) return BAD_CODE;
  const jar = await cookies();
  const replaced = await replaceLocalSession(jar.get(SESSION_COOKIE)?.value ?? "", { aal: "aal2", userAgent: (await headers()).get("user-agent") });
  if (!replaced || replaced.userId !== userId) redirect("/signin");
  setSessionCookie(jar, replaced.token);
  return session.mustChangePassword ? { status: "done", next: "/account/password" } : { status: "done" };
}

export async function startMfaEnrollment(): Promise<Enrollment> {
  const session = await sessionOrSignIn();
  if (isDemo()) return { ok: false, error: NO_MFA_IN_DEMO };
  if (mode() === "selfhost") {
    const local = await startLocalEnrollment(session.userId, session.email, serverEnv().OPS_ENCRYPTION_KEY);
    return local.ok ? { ok: true, factorId: "local", qr: local.qr, secret: local.secret } : local;
  }
  const supabase = await createClient();
  // An abandoned setup leaves an unverified factor behind; remove it so the friendly name is free again.
  const { data: list } = await supabase.auth.mfa.listFactors();
  for (const f of list?.all ?? []) {
    if (f.factor_type === "totp" && f.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "Watchbell" });
  if (error || !data) return { ok: false, error: "Couldn't start setup. Try again." };
  return { ok: true, factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
}

export async function confirmMfaEnrollment(_prev: MfaFormState, formData: FormData): Promise<MfaFormState> {
  const session = await sessionOrSignIn();
  const code = String(formData.get("code") ?? "").replace(/\s/g, "");
  const factorId = String(formData.get("factorId") ?? "");
  if (isDemo()) return { status: "error", message: NO_MFA_IN_DEMO };
  if (!/^\d{6}$/.test(code) || !factorId) return BAD_CODE;
  const limited = await underLimit(session.userId);
  if (limited) return limited;
  if (mode() === "selfhost") return finishLocal(session, "confirm", code);
  const supabase = await createClient();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) return BAD_CODE;
  return { status: "done" };
}

export async function verifyMfaCode(_prev: MfaFormState, formData: FormData): Promise<MfaFormState> {
  const session = await sessionOrSignIn();
  if (isDemo()) return { status: "error", message: NO_MFA_IN_DEMO };
  const code = String(formData.get("code") ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return BAD_CODE;
  const limited = await underLimit(session.userId);
  if (limited) return limited;
  if (mode() === "selfhost") {
    if ((await authProvider().hasVerifiedFactor(session.userId)) !== true) redirect("/mfa/setup");
    return finishLocal(session, "verify", code);
  }
  const supabase = await createClient();
  const { data } = await supabase.auth.mfa.listFactors();
  const factor = (data?.totp ?? []).find((f) => f.status === "verified");
  if (!factor) redirect("/mfa/setup");
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
  if (error) return BAD_CODE;
  return { status: "done" };
}
