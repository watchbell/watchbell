import { lookup as dnsLookup } from "node:dns/promises";
import { BODY_MAX_BYTES, type BodyRule, bodyProblem } from "@/lib/body-rule";
import { isBlockedAddress, urlProblem } from "@/lib/net/public-host";

export type CheckResult = { ok: boolean; statusCode: number | null; latencyMs: number | null; error: string | null };

export const MAX_REDIRECTS = 20;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BLOCKED: CheckResult = { ok: false, statusCode: null, latencyMs: null, error: "Blocked address" };
const UPTIME_AGENT = "OpsConsole-Uptime/1.0 (+https://west-solutions.web.id)";

async function resolveAddresses(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);
}

const isIpLiteral = (host: string) => host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host);

// sameOrigin: every hop must stay on the first address's origin (the security check's script reads); "www" also lets the
// host gain or lose a leading "www." (the security check's page read). Monitors don't set it, so their redirects to
// another host work as before.
// headers: extra request headers (RDAP's Accept); the User-Agent is set through userAgent.
type GuardOpts = { fetch?: typeof fetch; lookup?: (host: string) => Promise<string[]>; userAgent?: string; sameOrigin?: boolean | "www"; headers?: Record<string, string> };

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "");
function sameSite(a: URL, b: URL, www: boolean): boolean {
  if (a.origin === b.origin) return true;
  return www && a.protocol === b.protocol && a.port === b.port && bareHost(a.hostname) === bareHost(b.hostname);
}
type Followed = { res: Response; url: URL } | { refused: "blocked" | "redirects" | "origin" };

// The guard every outbound GET to an operator-typed or app-owned address goes through. The address is held to the
// same rules as at save time (https, port 443, a public host) on every request, and the host is resolved first: if ANY
// of its addresses is private the request is refused as "Blocked address". Redirects are followed by hand so each hop
// is checked the same way (a public page can't bounce the console to an internal address or down to plain http).
async function follow(url: string, o: GuardOpts, signal: AbortSignal, timedOut: Promise<never>): Promise<Followed> {
  const resolve = o.lookup ?? resolveAddresses;
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return { refused: "blocked" };
  }
  const first = current;
  for (let hop = 0; ; hop++) {
    if (urlProblem(current)) return { refused: "blocked" };
    if (o.sameOrigin && !sameSite(current, first, o.sameOrigin === "www")) return { refused: "origin" };
    if (!isIpLiteral(current.hostname)) {
      const addresses = await Promise.race([resolve(current.hostname), timedOut]);
      if (!addresses.length) throw new Error("no address");
      if (addresses.some(isBlockedAddress)) return { refused: "blocked" };
    }
    signal.throwIfAborted();
    const res = await (o.fetch ?? fetch)(current.toString(), {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      headers: { ...o.headers, "User-Agent": o.userAgent ?? UPTIME_AGENT },
      signal,
    });
    const location = REDIRECTS.has(res.status) ? res.headers.get("location") : null;
    if (location === null) return { res, url: current };
    await res.body?.cancel().catch(() => undefined);
    if (hop >= MAX_REDIRECTS) return { refused: "redirects" };
    try {
      current = new URL(location, current);
    } catch {
      return { refused: "blocked" };
    }
  }
}

// A rejection that fires when the signal aborts, for racing steps fetch's own signal doesn't cover (DNS, body reads).
function abortPromise(signal: AbortSignal): Promise<never> {
  const p = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  p.catch(() => undefined);
  return p;
}

// What went wrong, in the console's words.
function failureText(e: unknown, timeoutMs: number): string {
  const expired = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
  if (expired) return `No answer within ${expiredIn(timeoutMs)}`;
  // fetch reports a redirect loop as a TypeError whose cause says so.
  const cause = e instanceof TypeError && e.cause instanceof Error ? e.cause.message : "";
  return /redirect/i.test(cause) ? "Too many redirects" : "Couldn't connect";
}

const expiredIn = (timeoutMs: number) => (timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} s`);
function bodyReadText(e: unknown, timeoutMs: number): string {
  const expired = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
  return expired ? `Body not read within ${expiredIn(timeoutMs)}` : "Body couldn't be read";
}

export const REDIRECTED_AWAY = "Redirected to another site";
const REFUSED = { blocked: "Blocked address", redirects: "Too many redirects", origin: REDIRECTED_AWAY } as const;

// One GET per monitor. Plain http is refused at every hop, so only https→https redirects are followed ("/" → "/en", apex → www); the final status is compared. The timeout covers the
// whole chain, DNS included.
export async function checkUrl(
  url: string,
  opts: {
    expectedStatus?: number; timeoutMs?: number; fetch?: typeof fetch; clock?: () => number;
    lookup?: (host: string) => Promise<string[]>; body?: BodyRule | null;
  } = {},
): Promise<CheckResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const clock = opts.clock ?? (() => performance.now());
  const started = clock();
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const r = await follow(url, opts, signal, abortPromise(signal));
    if ("refused" in r) return r.refused === "blocked" ? BLOCKED : { ok: false, statusCode: null, latencyMs: null, error: REFUSED[r.refused] };
    const latencyMs = Math.round(clock() - started);
    const statusOk = r.res.status === (opts.expectedStatus ?? 200);
    // The body is read only when there is a rule and the status already passed (a wrong status is the failure to report).
    if (!statusOk || !opts.body) {
      await r.res.body?.cancel().catch(() => undefined);
      return { ok: statusOk, statusCode: r.res.status, latencyMs, error: statusOk ? null : `HTTP ${r.res.status}` };
    }
    // The server answered, so a body that doesn't arrive in time keeps the status and says what failed.
    let read: { bytes: Uint8Array; truncated: boolean };
    try {
      read = await readCapped(r.res, BODY_MAX_BYTES, abortPromise(signal));
    } catch (e) {
      return { ok: false, statusCode: r.res.status, latencyMs, error: bodyReadText(e, timeoutMs) };
    }
    const problem = bodyProblem(opts.body, new TextDecoder().decode(read.bytes), read.truncated);
    return { ok: problem === null, statusCode: r.res.status, latencyMs, error: problem };
  } catch (e) {
    return { ok: false, statusCode: null, latencyMs: null, error: failureText(e, timeoutMs) };
  }
}

export type SafeGetResult = { ok: true; status: number; url: string; body: string; truncated: boolean } | { ok: false; error: string };

// The monitors' guarded GET for reading a page or a script (the Next.js security check): same address rules and
// per-hop checks, plus a body read that stops at `maxBytes` (the rest is cancelled, never downloaded). The timeout
// covers DNS, every hop and the body; `signal` lets a caller with a wider deadline stop it early. Bodies are returned
// for scanning only, never stored.
export async function safeGet(
  url: string,
  opts: GuardOpts & { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<SafeGetResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 3 * 1024 * 1024;
  const signal = opts.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), opts.signal]) : AbortSignal.timeout(timeoutMs);
  const stop = abortPromise(signal);
  try {
    const r = await follow(url, opts, signal, stop);
    if ("refused" in r) return { ok: false, error: REFUSED[r.refused] };
    const { bytes, truncated } = await readCapped(r.res, maxBytes, stop);
    const body = new TextDecoder().decode(bytes);
    return { ok: true, status: r.res.status, url: r.url.toString(), body, truncated };
  } catch (e) {
    return { ok: false, error: failureText(e, timeoutMs) };
  }
}

// Reads a response body up to maxBytes, racing every read against `stop`, and cancels the rest. `truncated` is true
// only when there was more than the cap.
export async function readCapped(res: Response, maxBytes: number, stop: Promise<never>): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), stop]);
        if (done) break;
        const room = maxBytes - size;
        if (value.byteLength > room) {
          chunks.push(value.subarray(0, room));
          truncated = true;
          break;
        }
        chunks.push(value);
        size += value.byteLength;
        if (size === maxBytes) {
          truncated = !(await Promise.race([reader.read(), stop])).done;
          break;
        }
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

export { abortPromise };

export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}
