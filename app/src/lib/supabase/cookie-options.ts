// Watchbell 1.2.1 (audit L3): the Supabase session cookies (access and refresh token) are HttpOnly. No browser Supabase
// client exists (createBrowserClient appears nowhere; every Supabase call runs on the server), so no script needs to
// read them, and an XSS could no longer take the refresh token. Secure in production (local http dev keeps working).
export function supabaseCookieOptions(env: Record<string, string | undefined> = process.env) {
  return { httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "lax" as const, path: "/" };
}
