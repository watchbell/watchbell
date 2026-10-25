import { z } from "zod";
import { memoryLimiter } from "@/lib/memory-limit";
import { type Limit, type LimitDecision, LIMITS, minutesText } from "@/lib/rate-limit";

export type SignInState =
  | { status: "idle" }
  | { status: "sent"; email: string }
  | { status: "error"; message: string; field?: boolean };

type OtpArgs = { email: string; options: { shouldCreateUser: false; emailRedirectTo: string; captchaToken: string } };
type OtpFn = (args: OtpArgs) => Promise<{ error: { status?: number; code?: string; name?: string } | null }>;
type LimitFn = (l: Limit, subject: string) => Promise<LimitDecision>;

// Watchbell 1.2.1 (audit M2): sign-in requests per IP, in memory per server instance, counted before the first database
// write (the rate-limit row), so a flood with junk bot-check tokens doesn't reach Postgres. Looser than the database's
// per-IP limit (LIMITS.signinIp), which still decides for real traffic.
export const SIGNIN_PER_IP_MEMORY = { max: 10, windowMs: 15 * 60_000 } as const;
type Memory = ReturnType<typeof memoryLimiter>;
export const signinIpMemory: Memory = ((globalThis as { __watchbellSigninIp?: Memory }).__watchbellSigninIp ??= memoryLimiter(SIGNIN_PER_IP_MEMORY));

const UNAVAILABLE: SignInState = { status: "error", message: "We couldn't send the email right now. Try again in a minute." };

const tooMany = (d: LimitDecision): SignInState => ({ status: "error", message: `Too many sign-in attempts. Try again in ${minutesText(d.retryAfter)}.` });

export async function requestSignIn(
  rawEmail: string,
  deps: { signInWithOtp: OtpFn; siteUrl: string; captchaToken: string; ip: string; limit: LimitFn; peek: LimitFn; memory?: Memory },
): Promise<SignInState> {
  const email = rawEmail.trim().toLowerCase();
  if (!z.email().safeParse(email).success) return { status: "error", message: "Enter a valid email address.", field: true };
  if (!deps.captchaToken) return { status: "error", message: "Complete the bot check below first." };
  if (deps.memory && deps.ip !== "unknown") {
    const m = deps.memory.hit(deps.ip);
    if (!m.allowed) return tooMany(m);
  }
  try {
    // The IP is counted on every attempt. The email is only looked at here and counted after the bot check
    // passed, so someone with junk tokens can't use up an invited person's attempts.
    const ip = await deps.limit(LIMITS.signinIp, deps.ip);
    if (!ip.allowed) return tooMany(ip);
    const mail = await deps.peek(LIMITS.signinEmail, email);
    if (!mail.allowed) return tooMany(mail);

    const { error } = await deps.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: `${deps.siteUrl}/auth/confirm`, captchaToken: deps.captchaToken },
    });
    // auth-js returns (never throws) fetch failures: status 0 / no status, or AuthRetryableFetchError.
    if (error && (!error.status || error.status >= 500 || error.name === "AuthRetryableFetchError")) return UNAVAILABLE;
    // A failed bot check happens to everyone alike, so saying so reveals nothing about who is invited.
    if (error?.code === "captcha_failed") return { status: "error", message: "The bot check didn't pass. Try again." };
    // Unknown emails and Supabase's own rate limits get the same answer as success, and are counted the same way.
    if (error) console.warn(`sign-in request refused: ${error.code ?? error.status ?? "unknown"}`);
    await deps.limit(LIMITS.signinEmail, email);
  } catch {
    console.warn("sign-in request failed: limiter or Supabase unavailable");
    return UNAVAILABLE;
  }
  return { status: "sent", email };
}
