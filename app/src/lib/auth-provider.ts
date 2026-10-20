import "server-only";
import { isAuthSessionMissingError } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "@/db/client";
import { localUsers } from "@/db/schema";
import { clearSessionCookie, SESSION_COOKIE } from "@/lib/local-auth/session-cookie";
import { localSessionUserId, readLocalSession, revokeAllLocalSessions, revokeLocalSession } from "@/lib/local-auth/sessions-db";
import { mode } from "@/lib/mode";
import { createClient } from "@/lib/supabase/server";

// `mustChangePassword` (self-host only): the account still has the temporary password an owner gave it. Cloud has no
// passwords and leaves it out.
export type SessionUser = { userId: string; email: string; aal: string | undefined; mustChangePassword?: boolean };

// Who is signed in, whether they have a verified TOTP factor, and signing out. Cloud: Supabase Auth. Self-host: the
// local_users / local_sessions tables behind the wp_session cookie. src/lib/auth.ts builds the page and action gates on it.
export interface AuthProvider {
  sessionUser(): Promise<SessionUser | null>;
  // "signed-out": the session no longer exists server-side (revoked on another device, user deleted).
  hasVerifiedFactor(userId: string): Promise<boolean | "signed-out">;
  // Supabase's default scope is "global" (every session of the user); the local provider follows it.
  signOut(scope?: "local" | "global"): Promise<void>;
}

export const supabaseProvider: AuthProvider = {
  async sessionUser() {
    const supabase = await createClient();
    const { data } = await supabase.auth.getClaims();
    const claims = data?.claims;
    if (!claims || typeof claims.sub !== "string") return null;
    return { userId: claims.sub, email: String(claims.email ?? "").toLowerCase(), aal: typeof claims.aal === "string" ? claims.aal : undefined };
  },
  async hasVerifiedFactor() {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.mfa.listFactors();
    // The JWT still verifies locally, but its session was revoked (signed out on another device).
    if (isAuthSessionMissingError(error)) return "signed-out";
    // Never guess: an unreadable factor list must not look like "no factor" (that would let a Viewer with a factor through).
    if (error || !data) throw new Error("mfa factors unavailable");
    return data.totp.some((f) => f.status === "verified");
  },
  async signOut(scope) {
    const supabase = await createClient();
    if (scope) await supabase.auth.signOut({ scope });
    else await supabase.auth.signOut();
  },
};

export const localProvider: AuthProvider = {
  async sessionUser() {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return readLocalSession(token);
  },
  async hasVerifiedFactor(userId) {
    const [row] = await db().select({ confirmedAt: localUsers.totpConfirmedAt }).from(localUsers).where(eq(localUsers.id, userId)).limit(1);
    if (!row) return "signed-out";
    return row.confirmedAt !== null;
  },
  async signOut(scope = "global") {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    if (token) {
      if (scope === "global") {
        // Not readLocalSession: this browser's session may have ended already, and the other devices must still go.
        const userId = await localSessionUserId(token);
        if (userId) await revokeAllLocalSessions(userId);
      }
      await revokeLocalSession(token);
    }
    clearSessionCookie(jar);
  },
};

// Demo: the stateless signed wp_demo cookie (src/lib/demo/cookie.ts), never Supabase or the local_sessions table. The
// session is aal2 with a factor and no password to change, so the demo has no MFA or password step. The user id is the
// one the visitor's seeded member row has (an owner). Loaded on first use, so cloud and self-host never load it.
export const demoProvider: AuthProvider = {
  async sessionUser() {
    const [{ readDemoVisitor }, { demoUserId }] = await Promise.all([import("@/lib/demo/session"), import("@/lib/demo/seed/members")]);
    const visitor = await readDemoVisitor();
    if (!visitor) return null;
    return { userId: demoUserId(visitor.seed), email: visitor.email, aal: "aal2", mustChangePassword: false };
  },
  async hasVerifiedFactor() {
    return true;
  },
  // Nothing is kept server-side: ending the session is clearing the cookie (every scope alike).
  async signOut() {
    const { clearDemoCookie } = await import("@/lib/demo/cookie");
    clearDemoCookie(await cookies());
  },
};

export function authProvider(): AuthProvider {
  const m = mode();
  if (m === "selfhost") return localProvider;
  if (m === "demo") return demoProvider;
  return supabaseProvider;
}
