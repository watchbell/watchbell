"use server";

import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { currentMfa } from "@/lib/auth";
import { changeLocalPassword, type PasswordField } from "@/lib/local-auth/change-password";
import { SESSION_COOKIE, setSessionCookie } from "@/lib/local-auth/session-cookie";
import { mode } from "@/lib/mode";

// Passwords never come back in the state (a form action resets the fields).
export type PasswordFormState = { status: "idle" } | { status: "error"; message: string; field?: PasswordField };

const text = (fd: FormData, name: string) => String(fd.get(name) ?? "");

export async function changePassword(_prev: PasswordFormState, formData: FormData): Promise<PasswordFormState> {
  if (mode() !== "selfhost") notFound();
  // Signed in, a member, and past the MFA step: a password alone doesn't get to change the password.
  const { step } = await currentMfa();
  if (step === "setup") redirect("/mfa/setup");
  if (step === "challenge") redirect("/mfa");
  const jar = await cookies();
  let result;
  try {
    result = await changeLocalPassword({
      token: jar.get(SESSION_COOKIE)?.value ?? "",
      current: text(formData, "current"),
      password: text(formData, "password"),
      confirm: text(formData, "confirm"),
      userAgent: (await headers()).get("user-agent"),
    });
  } catch {
    console.warn("password change failed: database unavailable or the password could not be saved");
    return { status: "error", message: "The password wasn't changed. Try again in a minute." };
  }
  if (result.status === "signed-out") redirect("/signin");
  if (result.status === "error") return result;
  // The old token is gone and every other device is signed out; this browser carries on with the new one.
  setSessionCookie(jar, result.token);
  redirect("/");
}
