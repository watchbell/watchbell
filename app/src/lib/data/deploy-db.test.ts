import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db/client", () => ({ db: vi.fn() }));

import { hostStates } from "./deploy-db";

describe("hostStates", () => {
  it("a host with a working account is connected; one whose accounts all fail is broken; other providers are ignored", () => {
    const s = hostStates([
      { provider: "vercel", status: "error" }, { provider: "vercel", status: "ok" },
      { provider: "cloudflare", status: "error" }, { provider: "supabase", status: "ok" },
    ]);
    expect([...s.connected]).toEqual(["vercel"]);
    expect([...s.broken]).toEqual([]);
    expect([...hostStates([{ provider: "vercel", status: "error" }]).broken]).toEqual(["vercel"]);
  });
  it("no accounts: nothing connected, nothing broken", () => {
    const s = hostStates([]);
    expect(s.connected.size + s.broken.size).toBe(0);
  });
});
