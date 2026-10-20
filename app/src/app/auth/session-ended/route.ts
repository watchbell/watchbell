import { redirect } from "next/navigation";
import { authProvider } from "@/lib/auth-provider";

// The auth gate sends a session here when the auth provider says it no longer exists (signed out on another device).
// A Route Handler can clear the session cookies; a Server Component can't. Local scope: that session is
// already gone server-side, and a stray link here must not end the user's other sessions.
export async function GET() {
  await authProvider().signOut("local");
  redirect("/signin?error=session-ended");
}
