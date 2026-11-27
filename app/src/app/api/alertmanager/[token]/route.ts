import { after } from "next/server";
import { applyExternalAlerts, countIngest, findSourceByHash } from "@/lib/data/ingest-db";
import { deliverPending } from "@/lib/data/notify-db";
import { tokenHash } from "@/lib/heartbeat-token";
import { AM_MAX_BYTES, AM_PER_MINUTE, parseAlertmanager } from "@/lib/ingest/alertmanager";
import { readCapped } from "@/lib/ingest/body";
import { ingestThrottle } from "@/lib/ingest/throttle";
import { INGEST_TOKEN } from "@/lib/ingest/token";
import { requestIp } from "@/lib/memory-limit";
import { hitLimit } from "@/lib/rate-limit-db";

// Watchbell 1.8.6 (docs/superpowers/specs/2026-11-25-watchbell-1-8-6-alertmanager-design.md): Prometheus Alertmanager's
// webhook (version 4). The token in the path is the credential: the proxy lets the path through without session work,
// and the token can only write alerts. In order: the token's shape (no database), the per-IP guard and the memory of
// unknown tokens, the body (≤ 256 KB, counted as it arrives), JSON version 4 (≤ 100 alerts), the token by hash, 120
// alerts a minute per source, then one transaction. Notices go out after the response, like the watchdog's.
// Bodies are never logged: only the error's name.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const answer = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
const notFound = () => answer(404, { error: "Not found" });
const tooMany = (retryAfter: number) => answer(429, { error: "Too many alerts" }, { "Retry-After": String(Math.max(1, retryAfter)) });

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  if (!INGEST_TOKEN.test(token)) return notFound();
  const ip = requestIp(req.headers);
  const hash = tokenHash(token);
  if (ip) {
    const misses = ingestThrottle.misses.peek(ip);
    if (!misses.allowed) return tooMany(misses.retryAfter);
    const q = ingestThrottle.ip.hit(ip);
    if (!q.allowed) return tooMany(q.retryAfter);
  }
  if (ingestThrottle.unknown.has(hash)) return notFound();
  const read = await readCapped(req, AM_MAX_BYTES).catch(() => ({ ok: false as const }));
  if (!read.ok) return answer(413, { error: "Body over 256 KB" });
  try {
    const src = await findSourceByHash(hash);
    if (!src) {
      ingestThrottle.unknown.add(hash);
      if (ip) ingestThrottle.miss(ip, hash);
      return notFound();
    }
    const now = new Date();
    let json: unknown;
    try { json = JSON.parse(read.text); } catch { json = undefined; }
    const parsed = parseAlertmanager(json, now);
    if (!parsed.ok) {
      await countIngest(src, 0, 1, now);
      return answer(400, { error: parsed.error });
    }
    const n = parsed.alerts.length;
    if (n) {
      const lim = await hitLimit({ name: "alertmanager", max: AM_PER_MINUTE, windowSeconds: 60 }, src.id, n);
      if (!lim.allowed) {
        await countIngest(src, 0, n, now);
        return tooMany(lim.retryAfter);
      }
      await applyExternalAlerts(src, parsed.alerts, now);
    }
    await countIngest(src, n, 0, now);
    if (n) after(() => deliverPending(now, Date.now() + 8_000).then(() => undefined, (e: unknown) => console.warn("alertmanager notices failed:", e instanceof Error ? e.name : "error")));
    return answer(200, { accepted: n });
  } catch (e) {
    console.warn("alertmanager ingest failed:", e instanceof Error ? e.name : "error");
    return answer(503, { error: "Try again" });
  }
}
