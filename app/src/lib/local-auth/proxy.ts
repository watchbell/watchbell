import { type NextRequest, NextResponse } from "next/server";
import { ready } from "@/db/client";
import { clearSessionCookie, SESSION_COOKIE } from "./session-cookie";
import { readLocalSession } from "./sessions-db";

// The self-host counterpart of src/lib/supabase/proxy.ts updateSession. Proxy runs in the Node.js runtime (Next 16), so
// it can read the session table directly. A cookie whose session is unknown, revoked or ended is cleared.
export async function updateSessionLocal(request: NextRequest): Promise<{ response: NextResponse; userId: string | null }> {
  const response = NextResponse.next({ request });
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return { response, userId: null };
  // register() opens PGlite before the server takes requests; this is a no-op then, and a safety net otherwise.
  await ready();
  const session = await readLocalSession(token);
  if (!session) clearSessionCookie(response.cookies);
  return { response, userId: session?.userId ?? null };
}
