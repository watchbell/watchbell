import { z } from "zod";
import { safeNext } from "@/lib/paths";
import { MAX_DEMO_EMAIL, newDemoSeed, signDemoCookie } from "./cookie";

export const MAX_DEMO_PASSWORD = 200;

export type DemoSignInResult = { ok: true; cookie: string; redirectTo: string } | { ok: false; message: string; field: "email" | "password" };

// Demo sign-in: no accounts and no password check. Any valid email and any password of 1–200 characters get a signed
// cookie for that email with a new random seed, the published account too (ruling F): every sign-in is a dataset of its
// own. There is nothing to guess, so no failed-attempt limit; the action limits sign-ins per client instead
// (./visitor-limits), since each one can cost the server a new database.
export function demoSignIn(input: { email: string; password: string; next?: string | null }, key: Buffer, now: number = Date.now()): DemoSignInResult {
  const email = input.email.trim().toLowerCase();
  if (!email || email.length > MAX_DEMO_EMAIL || !z.email().safeParse(email).success) return { ok: false, message: "Enter a valid email address.", field: "email" };
  if (input.password.length < 1 || input.password.length > MAX_DEMO_PASSWORD) {
    return { ok: false, message: `Enter a password of 1 to ${MAX_DEMO_PASSWORD} characters (any password works in the demo).`, field: "password" };
  }
  return { ok: true, cookie: signDemoCookie({ email, seed: newDemoSeed() }, key, now), redirectTo: safeNext(input.next) };
}
