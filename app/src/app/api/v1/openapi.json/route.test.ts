import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/private/api/respond";

const h = vi.hoisted(() => ({ auth: vi.fn(), requireActionMember: vi.fn() }));
vi.mock("@/private/auth/api-key", () => ({ authenticateApiKey: h.auth }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));

import { GET } from "./route";

const call = (headers: Record<string, string> = {}) => GET(new Request("https://watch.example.com/api/v1/openapi.json", { headers }));

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/v1/openapi.json", () => {
  it("answers the document to any valid key (scope any)", async () => {
    h.auth.mockResolvedValue({ ok: true, key: {} });
    const r = await call({ authorization: "Bearer wp_x", host: "watch.example.com" });
    expect(r.status).toBe(200);
    expect(h.auth).toHaveBeenCalledWith(expect.any(Request), "any");
    expect(h.requireActionMember).not.toHaveBeenCalled();
    const doc = await r.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe("https://watch.example.com");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("judges a request that sends a key by the key alone: a bad key is 401 even for a signed-in owner", async () => {
    h.auth.mockResolvedValue({ ok: false, response: apiError("invalid_api_key", "no", 401) });
    h.requireActionMember.mockResolvedValue({ role: "owner" });
    expect((await call({ authorization: "Bearer wp_bad" })).status).toBe(401);
    expect(h.requireActionMember).not.toHaveBeenCalled();
  });

  it("answers the owner's session when no key is sent", async () => {
    h.requireActionMember.mockResolvedValue({ role: "owner" });
    const r = await call();
    expect(r.status).toBe(200);
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.auth).not.toHaveBeenCalled();
  });

  it("answers 401 with neither a key nor an owner session (an operator or signed-out visitor)", async () => {
    h.requireActionMember.mockRejectedValue(new Error("forbidden"));
    const r = await call();
    expect(r.status).toBe(401);
    expect((await r.json()).error.type).toBe("invalid_api_key");
  });
});
