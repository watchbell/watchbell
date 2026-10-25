import { type NextRequest, NextResponse } from "next/server";
import { ready } from "@/db/client";
import { rememberNetwork } from "@/lib/backoff-db";
import { negativeCache } from "@/lib/memory-limit";
import { selfhostClientIp } from "./client-ip";
import { clearSessionCookie, SESSION_COOKIE } from "./session-cookie";
import { hashToken } from "./session-token";
import { readLocalSession } from "./sessions-db";

// Review T2b-fix I-3: a session in use keeps its network "known" for the account (lib/backoff-db.ts), so the owner's own
// network never turns into a stranger's when the session that signed in from it runs out. At most once a day per
// session and network (per server instance), only behind a trusted proxy (the same address the sign-in uses).
const DAY_MS = 86_400_000;
const refreshed = negativeCache({ ttlMs: DAY_MS, maxKeys: 10_000 });

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
  else await keepNetworkKnown(token, session.email, request.headers);
  return { response, userId: session?.userId ?? null };
}

async function keepNetworkKnown(token: string, email: string, headers: Headers): Promise<void> {
  const ip = selfhostClientIp(headers);
  if (!ip) return;
  const key = `${hashToken(token)} ${ip}`;
  const now = Date.now();
  if (refreshed.has(key, now)) return;
  refreshed.add(key, now);
  // Never fails the request; the next request tries again.
  await rememberNetwork(email.toLowerCase(), ip, new Date(now)).catch(() => refreshed.delete(key));
}
