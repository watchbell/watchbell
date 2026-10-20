import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const owner = { id: "mem-1", userId: "user-1", email: "o@example.com", role: "owner" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), limit: vi.fn(), usageExport: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/rate-limit-db", () => ({ limit: h.limit }));
vi.mock("@/private/ai/views-db", () => ({ usageExport: h.usageExport }));

import { exportLogsCsv } from "./actions";

const row = { id: 1, at: new Date("2026-10-13T00:41:12Z"), keyName: "k", client: "gemini-cli/0.9.0", model: null, kind: "mcp", tool: "get_app", tokensIn: null, tokensOut: null, latencyMs: 180, status: 200, errorClass: null, stream: false };

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(owner);
  h.limit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  h.usageExport.mockResolvedValue([row]);
});

describe("exportLogsCsv", () => {
  it("is owner only", async () => {
    await exportLogsCsv({});
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect((await exportLogsCsv({})).ok).toBe(false);
  });
  it("exports the filtered rows as CSV, passing only parsed filters on", async () => {
    const r = await exportLogsCsv({ status: "error", key: "not-a-uuid", client: "gemini" });
    expect(h.usageExport).toHaveBeenCalledWith({ status: "error", client: "gemini" });
    expect(r.ok && r.data?.rows).toBe(1);
    expect(r.ok && r.data?.csv.split("\r\n")[0]).toBe("Time (WIB),Key,Client,Model / tool,Tokens in,Tokens out,Latency ms,Status,Stream,Error class");
  });
  it("stops at the rate limit before reading", async () => {
    h.limit.mockResolvedValue({ allowed: false, retryAfter: 300 });
    expect((await exportLogsCsv({})).ok).toBe(false);
    expect(h.usageExport).not.toHaveBeenCalled();
  });
});
