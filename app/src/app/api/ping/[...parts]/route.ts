import { recordPing } from "@/lib/data/heartbeats-db";
import { parsePing } from "@/lib/heartbeat";

// U3. GET, POST or HEAD /api/ping/{token}[/fail|/start] from the owner's own jobs (curl -fsS -m 10 <url>). The body is
// never read; answers are tiny and never cached. 404 for anything that isn't a known token (B2): a malformed token
// never reaches the database, and an unknown one costs one indexed read and no write. The proxy lets this path
// through before any session or cookie is read (proxy.ts): the token is the credential.
async function ping(_req: Request, ctx: { params: Promise<{ parts: string[] }> }): Promise<Response> {
  const parsed = parsePing((await ctx.params).parts ?? []);
  const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };
  if (!parsed) return new Response("Not found", { status: 404, headers });
  const r = await recordPing(parsed.token, parsed.kind, new Date()).catch((e: unknown) => {
    // Only the error's name: a message could carry query parameters, and the token never goes into a log.
    console.warn("ping failed:", e instanceof Error ? e.name : "unknown");
    return { status: "error" as const };
  });
  if (r.status === "unknown") return new Response("Not found", { status: 404, headers });
  if (r.status === "limited") return new Response("Too many pings", { status: 429, headers: { ...headers, "Retry-After": String(Math.max(1, r.retryAfter)) } });
  if (r.status === "error") return new Response("Try again", { status: 503, headers });
  return new Response("OK", { status: 200, headers });
}

export const GET = ping;
export const POST = ping;
export const HEAD = ping;
