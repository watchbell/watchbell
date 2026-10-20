import { DemoUnavailable } from "./simulate";

// Demo mode never calls a real provider (Vercel, Supabase, Telegram, Discord, Resend, an AI gateway ...). register()
// installs this around the global fetch: anything that is not an absolute URL on the demo's own origin (SITE_URL,
// compared exactly: scheme, host and port) is rejected with DemoUnavailable before it leaves the process. A relative
// path never passes (server-side fetch can't resolve one anyway). Redirects are refused unless the call's init says how
// to handle them (a Request's own redirect setting is ignored: it always reads "follow" when unset, so it can't tell a
// choice from the default), so a same-origin URL can't bounce the request somewhere else. It guards fetch only; senders and the AI
// gateway also no-op on their own. A blocked call logs one console.debug line (origin only); Next's internal fetch for a
// Server Action redirect gets an empty answer instead of a throw, and logs nothing.
type Fetch = typeof fetch;
type Flagged = { __watchpostFetchGuard?: boolean };

function siteOrigin(): string | null {
  const raw = (process.env.SITE_URL ?? "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function targetOrigin(input: Parameters<Fetch>[0]): string | null {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : String(input);
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

// Next's own fetch of the page a Server Action redirected to (next/dist/server/app-render/action-handler.js marks it
// `next: { internal: 1 }`). It goes to the address the server listens on, which behind a proxy isn't SITE_URL.
function nextInternal(init: RequestInit | undefined): boolean {
  return !!(init as { next?: { internal?: unknown } } | undefined)?.next?.internal;
}

export function guardedFetch(inner: Fetch): Fetch {
  return async (input, init) => {
    const target = targetOrigin(input);
    const site = siteOrigin();
    if (site && target === site) return inner(input, { ...init, redirect: init?.redirect ?? "error" });
    // Still blocked, quietly: an empty answer that isn't RSC makes Next fall back to the plain redirect it would do anyway,
    // where a throw made it console.error "failed to get redirect response" with the whole stack on every redirect.
    if (nextInternal(init)) return new Response(null, { status: 204 });
    // One short debug line; the origin only, since a path can carry a token (Telegram's /bot<token>/).
    console.debug(`demo: outbound fetch blocked (${target && target !== "null" ? target : "not an absolute URL"})`);
    throw new DemoUnavailable();
  };
}

// Idempotent: a dev reload that runs register() again must not stack wrappers.
export function installFetchGuard(): void {
  const g = globalThis as Flagged;
  if (g.__watchpostFetchGuard) return;
  g.__watchpostFetchGuard = true;
  globalThis.fetch = guardedFetch(globalThis.fetch);
}
