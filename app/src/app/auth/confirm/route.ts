import type { EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { touchLastSeen } from "@/lib/auth";
import { isDemo } from "@/lib/mode";
import { safeNext } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

const ALLOWED = new Set<EmailOtpType>(["email", "magiclink", "invite"]);

async function recordSignIn(userId: string | undefined) {
  if (!userId) return;
  try {
    await touchLastSeen(userId);
  } catch {
    console.warn("last_seen update failed");
  }
}

export async function GET(request: NextRequest) {
  // The demo has no email links and must never reach Supabase.
  if (isDemo()) redirect("/signin?error=link");
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const type = params.get("type") as EmailOtpType | null;
  const code = params.get("code");
  const next = safeNext(params.get("next"), type === "invite" ? "/invite" : "/");

  if (tokenHash && type && ALLOWED.has(type)) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      await recordSignIn(data.user?.id);
      redirect(next);
    }
  } else if (code) {
    // Supabase's default email template (the only one available without custom SMTP) sends the link back
    // as ?code=. The PKCE verifier cookie was set by the sign-in action in this same browser.
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      await recordSignIn(data.user?.id);
      redirect(next);
    }
  }
  redirect("/signin?error=link");
}
