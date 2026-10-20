// Per-client limits on what costs the demo server memory and CPU: a sign-in (each one gets a new dataset) and the
// creation of a visitor's database (migrate + seed, about 200-250 MB while it lives). In memory, per server process, a
// sliding window per client. Nothing here refuses everyone at once: the only global limit is the pool's cap (./pool).
//
// Who the client is: on Vercel (VERCEL=1) the left-most x-forwarded-for address, which Vercel sets itself (it replaces
// whatever the client sent). Anywhere else no header can be trusted (lib/local-auth/client-ip.ts), so every visitor
// shares one bucket with a generous limit.
const MINUTE = 60_000;
export const DEMO_LIMIT_WINDOW_MS = 10 * MINUTE;
// Per address on Vercel, per DEMO_LIMIT_WINDOW_MS.
export const CREATIONS_PER_CLIENT = 5;
export const SIGN_INS_PER_CLIENT = 10;
// The shared bucket outside Vercel: everyone together, so far more.
export const CREATIONS_SHARED = 60;
export const SIGN_INS_SHARED = 120;
export const SHARED_CLIENT = "shared";
// Clients remembered at once; past that the oldest are forgotten (a forgotten client simply starts over).
const MAX_CLIENTS = 10_000;

export const DEMO_SIGN_IN_LIMITED = "Too many demo sign-ins from your network. Try again in a few minutes.";

export function demoClientKey(headers: Headers, source: Record<string, string | undefined> = process.env): string {
  if (source.VERCEL !== "1") return SHARED_CLIENT;
  const ip = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `ip:${ip ? clientNetwork(ip) : "unknown"}`;
}

// IPv6 by its /64: one host usually owns a whole /64 and could rotate through it to dodge a per-address limit.
// IPv4 (and anything unparsable) stays the full address.
export function clientNetwork(ip: string): string {
  if (!ip.includes(":") || ip.includes(".")) return ip;
  const [head, tail] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return ip;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

type Limit = { perClient: number; shared: number };

// A sliding window per client: `id` names what is counted, so the same id within the window counts once (a database
// re-created for the same seed after it was closed for space is not a new one).
export function windowLimiter(limit: Limit, windowMs: number = DEMO_LIMIT_WINDOW_MS) {
  const clients = new Map<string, Map<string, number>>(); // client → id → when first counted
  const prune = (seen: Map<string, number>, now: number) => {
    for (const [id, at] of seen) if (now - at >= windowMs) seen.delete(id);
  };
  return {
    // True (and counted) when the client is under its limit, or already counted this id within the window.
    take(client: string, id: string, now: number = Date.now()): boolean {
      let seen = clients.get(client);
      if (seen) {
        prune(seen, now);
        clients.delete(client); // re-inserted below as the most recently seen client
      } else {
        seen = new Map();
      }
      clients.set(client, seen);
      if (clients.size > MAX_CLIENTS) clients.delete(clients.keys().next().value!);
      if (seen.has(id)) return true;
      if (seen.size >= (client === SHARED_CLIENT ? limit.shared : limit.perClient)) return false;
      seen.set(id, now);
      return true;
    },
    reset(): void {
      clients.clear();
    },
  };
}

type Limits = { creations: ReturnType<typeof windowLimiter>; signIns: ReturnType<typeof windowLimiter> };
// On globalThis, like the pool, so a dev-server reload doesn't start every count over.
const limits: Limits = ((globalThis as { __watchpostDemoLimits?: Limits }).__watchpostDemoLimits ??= {
  creations: windowLimiter({ perClient: CREATIONS_PER_CLIENT, shared: CREATIONS_SHARED }),
  signIns: windowLimiter({ perClient: SIGN_INS_PER_CLIENT, shared: SIGN_INS_SHARED }),
});
export const demoCreations = limits.creations;
export const demoSignIns = limits.signIns;

// Tests only (refused outside vitest): forget every count.
export function resetDemoLimitsForTests(): void {
  if (!process.env.VITEST) throw new Error("resetDemoLimitsForTests is for tests only");
  demoCreations.reset();
  demoSignIns.reset();
}
