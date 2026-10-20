import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ handleMcp: vi.fn(async () => new Response(null, { status: 202 })) }));
vi.mock("@/private/mcp/server", () => ({ handleMcp: h.handleMcp }));

import { DELETE, GET, POST } from "./route";

describe("/api/v1/mcp", () => {
  it("POST goes to the MCP server", async () => {
    const req = new Request("https://ops.example.com/api/v1/mcp", { method: "POST", body: "{}" });
    expect((await POST(req)).status).toBe(202);
    expect(h.handleMcp).toHaveBeenCalledWith(req);
  });

  it("GET and DELETE → 405 method_not_allowed with Allow: POST (no SSE stream, no sessions)", async () => {
    for (const res of [await GET(), await DELETE()]) {
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toMatchObject({ error: { type: "method_not_allowed" } });
    }
  });
});
