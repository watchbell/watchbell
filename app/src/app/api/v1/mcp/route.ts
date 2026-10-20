import { apiError } from "@/private/api/respond";
import { handleMcp } from "@/private/mcp/server";

export const dynamic = "force-dynamic";

// The MCP endpoint (Streamable HTTP, stateless). POST carries one JSON-RPC message; there is no standalone SSE stream
// and no session to end, so GET and DELETE answer 405 (spec 2026-07-28, and what older clients expect when a server
// offers no GET stream).
export async function POST(req: Request): Promise<Response> {
  return handleMcp(req);
}

const notAllowed = () => apiError("method_not_allowed", "The MCP endpoint takes POST only (Streamable HTTP, JSON answers, no SSE stream).", 405, { Allow: "POST" });

export async function GET(): Promise<Response> {
  return notAllowed();
}

export async function DELETE(): Promise<Response> {
  return notAllowed();
}
