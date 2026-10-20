"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp } from "@/lib/client-ip";
import { serverEnv } from "@/lib/env";
import { selfhostClientIp } from "@/lib/local-auth/client-ip";
import { SESSION_COOKIE, setSessionCookie } from "@/lib/local-auth/session-cookie";
import { passwordSignIn, type PasswordSignInState } from "@/lib/local-auth/signin";
import { isDemo, mode, usesLocalAuth } from "@/lib/mode";
import { limit, peekLimit } from "@/lib/rate-limit-db";
import { requestSignIn, type SignInState } from "@/lib/signin";
import { createClient } from "@/lib/supabase/server";

export async function sendSignInLink(_prev: SignInState, formData: FormData): Promise<SignInState> {
  // Self-host and demo have no Supabase Auth and sign in with a password (signInWithPassword below).
  if (usesLocalAuth()) return { status: "error", message: "Email sign-in links are not available here." };
  const supabase = await createClient();
  return requestSignIn(String(formData.get("email") ?? ""), {
    signInWithOtp: (args) => supabase.auth.signInWithOtp(args),
    siteUrl: serverEnv().SITE_URL,
    captchaToken: String(formData.get("cf-turnstile-response") ?? ""),
    ip: clientIp(await headers()),
    limit,
    peek: peekLimit,
  });
}

// Self-host: email + password against local_users. Demo: any email and password, answered with its own signed cookie
// (no accounts, no database). Cloud keeps the magic link above and never accepts this form.
export async function signInWithPassword(_prev: PasswordSignInState, formData: FormData): Promise<PasswordSignInState> {
  const email = String(formData.get("email") ?? "").slice(0, 254);
  if (isDemo()) return demoPasswordSignIn(formData);
  if (mode() !== "selfhost") return { status: "error", message: "Password sign-in is not available here.", email };
  const h = await headers();
  const jar = await cookies();
  const result = await passwordSignIn({
    email,
    password: String(formData.get("password") ?? ""),
    ip: selfhostClientIp(h),
    userAgent: h.get("user-agent"),
    presentedToken: jar.get(SESSION_COOKIE)?.value,
    next: String(formData.get("next") ?? ""),
  });
  if (!result.ok) return { status: "error", message: result.message, email };
  setSessionCookie(jar, result.token);
  redirect(result.redirectTo);
}

// The whole email is checked (an over-long one is refused, not cut to fit); only the echo in the form is cut to 254.
// Each sign-in is a new dataset, so a client gets a few per 10 minutes (lib/demo/visitor-limits.ts).
async function demoPasswordSignIn(formData: FormData): Promise<PasswordSignInState> {
  const email = String(formData.get("email") ?? "");
  const [{ demoSignIn }, { serverDemoCookieKey }, { setDemoCookie }, limits] = await Promise.all([
    import("@/lib/demo/signin"),
    import("@/lib/demo/session"),
    import("@/lib/demo/cookie"),
    import("@/lib/demo/visitor-limits"),
  ]);
  const result = demoSignIn({ email, password: String(formData.get("password") ?? ""), next: String(formData.get("next") ?? "") }, serverDemoCookieKey());
  if (!result.ok) return { status: "error", message: result.message, email: email.slice(0, 254), field: result.field };
  if (!limits.demoSignIns.take(limits.demoClientKey(await headers()), crypto.randomUUID())) {
    return { status: "error", message: limits.DEMO_SIGN_IN_LIMITED, email: email.slice(0, 254) };
  }
  setDemoCookie(await cookies(), result.cookie);
  redirect(result.redirectTo);
}
