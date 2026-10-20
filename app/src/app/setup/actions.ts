"use server";

import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { serverEnv } from "@/lib/env";
import { selfhostClientIp } from "@/lib/local-auth/client-ip";
import { SESSION_COOKIE, setSessionCookie } from "@/lib/local-auth/session-cookie";
import { createLocalSession, revokeLocalSession } from "@/lib/local-auth/sessions-db";
import { completeSetup, type SetupField } from "@/lib/local-auth/setup";
import { mode } from "@/lib/mode";
import { limit, peekLimit } from "@/lib/rate-limit-db";

// The typed code and email come back so the form can refill them (a form action resets the form); passwords never do.
export type SetupFormState =
  | { status: "idle" }
  | { status: "error"; message: string; field?: SetupField; code: string; email: string };

const text = (fd: FormData, name: string) => String(fd.get(name) ?? "");

export async function submitSetup(_prev: SetupFormState, formData: FormData): Promise<SetupFormState> {
  if (mode() !== "selfhost") notFound();
  const h = await headers();
  const typed = { code: text(formData, "code").slice(0, 20), email: text(formData, "email").slice(0, 320) };
  let result;
  try {
    result = await completeSetup(
      { code: text(formData, "code"), email: text(formData, "email"), password: text(formData, "password"), confirm: text(formData, "confirm") },
      { ip: selfhostClientIp(h), key: Buffer.from(serverEnv().OPS_ENCRYPTION_KEY, "base64"), limit, peek: peekLimit },
    );
  } catch {
    console.warn("setup failed: database unavailable or the account could not be saved");
    return { status: "error", message: "Setup didn't go through. Try again in a minute.", ...typed };
  }
  if (result.status === "done") return { status: "error", message: "This console already has an owner. Sign in instead.", ...typed };
  if (result.status === "error") return { ...result, ...typed };

  // A browser that still carries an older session (another account on this install) gives it up first.
  const jar = await cookies();
  const previous = jar.get(SESSION_COOKIE)?.value;
  if (previous) await revokeLocalSession(previous);
  const { token } = await createLocalSession(result.userId, { aal: "aal1", userAgent: h.get("user-agent") });
  setSessionCookie(jar, token);
  // Owners must have TOTP (src/lib/mfa.ts): the next stop is enrolling it.
  redirect("/mfa/setup");
}
