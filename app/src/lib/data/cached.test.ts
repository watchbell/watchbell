import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// unstable_cache as Next.js stores it: a JSON copy (what a cache hit hands back). Each registration is recorded.
const h = vi.hoisted(() => ({
  registered: [] as { keyParts: string[]; options: { revalidate?: number; tags?: string[] } }[],
  cacheCalls: 0,
  listDatabases: vi.fn(), supabaseSlotInputs: vi.fn(), databaseOptions: vi.fn(),
  listDomains: vi.fn(), listZoneOptions: vi.fn(), getZoneView: vi.fn(), readProviderStatus: vi.fn(), readAliasBook: vi.fn(),
}));
vi.mock("next/cache", () => ({
  unstable_cache: (cb: (...a: unknown[]) => Promise<unknown>, keyParts: string[], options: { revalidate?: number; tags?: string[] }) => {
    h.registered.push({ keyParts, options });
    return async (...a: unknown[]) => {
      h.cacheCalls++;
      return JSON.parse(JSON.stringify(await cb(...a)));
    };
  },
}));
vi.mock("./databases-db", () => ({ listDatabases: h.listDatabases, supabaseSlotInputs: h.supabaseSlotInputs, databaseOptions: h.databaseOptions }));
vi.mock("./network-db", () => ({ listDomains: h.listDomains, listZoneOptions: h.listZoneOptions, getZoneView: h.getZoneView }));
vi.mock("./provider-status-db", () => ({ readProviderStatus: h.readProviderStatus }));
vi.mock("./aliases-db", () => ({ readAliasBook: h.readAliasBook }));

import { cacheBuildKey } from "@/lib/cache/tags";
import * as cached from "./cached";

beforeEach(() => {
  h.cacheCalls = 0;
  for (const f of [h.listDatabases, h.supabaseSlotInputs, h.databaseOptions, h.listDomains, h.listZoneOptions, h.getZoneView, h.readProviderStatus, h.readAliasBook]) f.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

describe("cached readers (perf P3)", () => {
  it("every reader is cached for 5 minutes under its own key, with the tags its writers expire", () => {
    const build = cacheBuildKey(process.env);
    // Review I1: the deployment (and shape version) is the second key part of every entry.
    for (const r of h.registered) expect(r.keyParts.slice(0, 2)).toEqual(["ops", build]);
    const byKey = Object.fromEntries(h.registered.map((r) => [[r.keyParts[0], ...r.keyParts.slice(2)].join("/"), r.options]));
    expect(byKey).toEqual({
      "ops/listDatabases/supabase_project": { revalidate: 300, tags: ["db:supabase"] },
      "ops/listDatabases/neon_project": { revalidate: 300, tags: ["db:neon"] },
      "ops/listDatabases/firestore": { revalidate: 300, tags: ["db:firebase"] },
      "ops/listDatabases/turso_database": { revalidate: 300, tags: ["db:extra"] },
      "ops/listDatabases/upstash_redis": { revalidate: 300, tags: ["db:extra"] },
      "ops/listDatabases/d1_database": { revalidate: 300, tags: ["db:extra"] },
      "ops/supabaseSlotInputs": { revalidate: 300, tags: ["db:supabase"] },
      "ops/databaseOptions": { revalidate: 300, tags: ["db:supabase", "db:neon", "db:firebase", "db:extra"] },
      "ops/listDomains": { revalidate: 300, tags: ["net:domains", "net:zones"] },
      "ops/listZoneOptions": { revalidate: 300, tags: ["net:zones"] },
      "ops/getZoneView": { revalidate: 300, tags: ["net:zones"] },
      "ops/providerStatus": { revalidate: 300, tags: ["status"] },
      "ops/aliasBook": { revalidate: 300, tags: ["db:supabase", "db:neon", "db:firebase", "db:extra", "net:zones", "net:domains"] },
    });
    // The wrappers' callbacks have the same source text, which unstable_cache puts in the key: the key parts must differ.
    expect(new Set(h.registered.map((r) => r.keyParts.join("/"))).size).toBe(h.registered.length);
  });

  it("reads the kind asked for, and hands Dates back as Dates after the cache's JSON copy", async () => {
    const at = new Date("2026-10-13T01:00:00Z");
    h.listDatabases.mockResolvedValue([{ id: "d1", stateSince: at, collectedAt: null, usedBy: [] }]);
    const rows = await cached.listDatabases("neon_project");
    expect(h.listDatabases).toHaveBeenCalledWith("neon_project");
    expect(rows[0].stateSince).toBeInstanceOf(Date);
    expect(rows[0].stateSince?.getTime()).toBe(at.getTime());
    expect(rows[0].collectedAt).toBeNull();
  });

  it("passes the zone id through, so it is part of the cache key", async () => {
    h.getZoneView.mockResolvedValue(null);
    await cached.getZoneView("123e4567-e89b-42d3-a456-426614174000");
    expect(h.getZoneView).toHaveBeenCalledWith("123e4567-e89b-42d3-a456-426614174000");
  });

  it("caches the stored provider rows, not the page text: 'checked 2 min ago' is worked out per request", async () => {
    const checkedAt = new Date("2026-10-13T01:00:00Z");
    h.readProviderStatus.mockResolvedValue([{ provider: "vercel", state: "ok", description: "", incidents: [], checkedAt, lastOkAt: checkedAt, error: null }]);
    const [row] = await cached.readProviderStatus();
    expect(row.checkedAt).toBeInstanceOf(Date);
  });
});

describe("cached readers outside cloud (selfhost runs them from its own scheduler, outside any request)", () => {
  it("in cloud the read goes through unstable_cache", async () => {
    vi.stubEnv("WATCHPOST_MODE", "");
    h.readAliasBook.mockResolvedValue({});
    await cached.aliasBook();
    expect(h.cacheCalls).toBe(1);
  });
  it.each(["selfhost", "demo"])("in %s it calls the reader directly, so no request scope or incremental cache is needed", async (m) => {
    vi.stubEnv("WATCHPOST_MODE", m);
    const at = new Date("2026-10-13T01:00:00Z");
    h.listDatabases.mockResolvedValue([{ id: "d1", stateSince: at }]);
    const rows = await cached.listDatabases("neon_project");
    expect(h.cacheCalls).toBe(0);
    expect(h.listDatabases).toHaveBeenCalledWith("neon_project");
    expect(rows[0].stateSince).toBe(at);
    h.getZoneView.mockResolvedValue(null);
    await cached.getZoneView("z1");
    expect(h.getZoneView).toHaveBeenCalledWith("z1");
    expect(h.cacheCalls).toBe(0);
  });
});
