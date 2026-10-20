import { readEnv } from "@/lib/brand-env";

// The client's address on a self-host install, for per-IP rate limits. A bare install has no proxy that sets a header,
// and any header a client sends itself can be forged, so an address is only trusted when the operator says how many
// reverse proxies sit in front: WATCHBELL_TRUSTED_PROXY_HOPS=n (or the old WATCHPOST_ name). Each proxy appends the
// address it received the request from to x-forwarded-for, so the n-th entry from the right is what the outermost
// trusted proxy saw; anything left of it came from the client. x-real-ip is ignored (a proxy may pass a client's own value through). Unset, 0 or invalid: null,
// meaning "unknown", and callers must not key a limit on it. Cloud uses src/lib/client-ip.ts (Vercel sets the headers).
export function selfhostClientIp(headers: Headers, source: Record<string, string | undefined> = process.env): string | null {
  const raw = (readEnv(source, "TRUSTED_PROXY_HOPS") ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const hops = Number(raw);
  if (hops < 1) return null;
  const chain = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (chain.length < hops) return null;
  return chain[chain.length - hops];
}
