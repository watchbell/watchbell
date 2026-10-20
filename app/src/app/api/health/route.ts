export const dynamic = "force-dynamic";

// Liveness for an uptime checker: 200 while the console answers. Public and read-only: no session, no key, no database.
const headers = { "Cache-Control": "no-store" };

export async function GET(): Promise<Response> {
  return Response.json({ ok: true, service: "watchbell" }, { headers });
}

export async function HEAD(): Promise<Response> {
  return new Response(null, { status: 200, headers });
}
