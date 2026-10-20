import { beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "@/db/schema";
import { fakeDb, limitOf, payloadOf, type Call } from "@/lib/data/fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));

import { EXPORT_MAX_ROWS, hasEnabledProvider, keyUsage, limitProviders, LOG_COLUMNS, LOG_MAX_PAGE_SIZE, modelRows, overviewCounts, setDefaultModel, usageExport, usageLog } from "./views-db";

const NOW = new Date("2026-10-13T05:00:00Z");
const use = (results: unknown[][], writes: unknown[][] = []) => {
  const f = fakeDb(results, writes);
  h.current = f;
  return f;
};
const offsetOf = (q: Call[]) => q.find((c) => c.method === "offset")?.args[0];
const selectedKeys = (q: Call[]) => Object.keys(q.find((c) => c.method === "select")?.args[0] as object);

const row = (id: number, o: Record<string, unknown> = {}) => ({
  id, at: new Date(NOW.getTime() - id * 1000), keyName: "laptop-agents", clientName: "gemini-cli", clientVersion: "0.9.0", model: null, kind: "mcp", tool: "get_app",
  tokensIn: null, tokensOut: null, latencyMs: 180, status: 200, errorClass: null, stream: false, ...o,
});

beforeEach(() => {
  h.current = null;
});

describe("usageLog", () => {
  it("selects metadata columns only: no prompt, completion, body or message column exists", async () => {
    const f = use([[row(1)]]);
    await usageLog({}, 1);
    const keys = selectedKeys(f.queries[0]);
    expect(keys.sort()).toEqual([...LOG_COLUMNS].sort());
    for (const k of keys) expect(k).not.toMatch(/prompt|completion|content|message|body|text/i);
  });

  it("caps the page size at 100 (asks for one more row to know if there is a next page)", async () => {
    const f = use([[row(1)]]);
    await usageLog({}, 1, 100_000);
    expect(limitOf(f.queries[0])).toBe(LOG_MAX_PAGE_SIZE + 1);
    const g = use([[row(1)]]);
    await usageLog({}, 1, 0);
    expect(limitOf(g.queries[0])).toBe(51);
  });

  it("pages by offset and reports hasMore from the extra row", async () => {
    const f = use([Array.from({ length: 51 }, (_, i) => row(i + 1))]);
    const r = await usageLog({}, 3);
    expect(offsetOf(f.queries[0])).toBe(100);
    expect(r.rows).toHaveLength(50);
    expect(r.hasMore).toBe(true);
    expect(r.page).toBe(3);
    const last = await (async () => { use([[row(1), row(2)]]); return usageLog({}, 1); })();
    expect(last.hasMore).toBe(false);
  });

  it("joins the client as name/version and clamps a silly page number", async () => {
    const f = use([[row(1), row(2, { clientName: null, clientVersion: null })]]);
    const r = await usageLog({ status: "error", client: "100%_x" }, -5);
    expect(r.page).toBe(1);
    expect(offsetOf(f.queries[0])).toBe(0);
    expect(r.rows.map((x) => x.client)).toEqual(["gemini-cli/0.9.0", null]);
  });
});

describe("usageExport", () => {
  it("reads the same columns, up to 5,000 rows", async () => {
    const f = use([[row(1)]]);
    const r = await usageExport({});
    expect(limitOf(f.queries[0])).toBe(EXPORT_MAX_ROWS + 1);
    expect(selectedKeys(f.queries[0]).sort()).toEqual([...LOG_COLUMNS].sort());
    expect(r).toHaveLength(1);
  });
});

describe("overviewCounts", () => {
  it("counts keys by state, today's requests and the agents seen in 24 h", async () => {
    use([
      [{ name: "Google Gemini", kind: "gemini", enabled: true, isDefault: true, lastTestStatus: 200 }],
      [
        { revokedAt: null, expiresAt: null, lastUsedAt: NOW },
        { revokedAt: null, expiresAt: null, lastUsedAt: null },
        { revokedAt: NOW, expiresAt: null, lastUsedAt: NOW },
        { revokedAt: null, expiresAt: new Date(NOW.getTime() - 1000), lastUsedAt: NOW },
      ],
      [{ requests: "249", rateLimited: "2", refused: "1" }],
      [{ clientName: "gemini-cli", lastSeenAt: NOW }, { clientName: "antigravity", lastSeenAt: NOW }, { clientName: "gemini-cli", lastSeenAt: NOW }],
    ]);
    const c = await overviewCounts(NOW);
    expect(c.keys).toEqual({ active: 2, revoked: 1, neverUsed: 1 });
    expect(c.today).toEqual({ requests: 249, rateLimited: 2, refused: 1 });
    expect(c.agents).toEqual({ active24h: 2, names: ["gemini-cli", "antigravity"] });
    expect(c.providers[0].kind).toBe("gemini");
  });

  it("is all zeros on an empty console", async () => {
    use([[], [], [], []]);
    const c = await overviewCounts(NOW);
    expect(c.keys).toEqual({ active: 0, revoked: 0, neverUsed: 0 });
    expect(c.today).toEqual({ requests: 0, rateLimited: 0, refused: 0 });
    expect(c.agents.active24h).toBe(0);
  });
});

describe("other reads", () => {
  it("hasEnabledProvider reads a count", async () => {
    use([[{ n: 1 }]]);
    expect(await hasEnabledProvider()).toBe(true);
    use([[{ n: 0 }]]);
    expect(await hasEnabledProvider()).toBe(false);
  });

  it("limitProviders reads the enabled connections with their own limits", async () => {
    const limits = [{ metric: "requests", scope: "all", limit: 10, window: "day" }];
    const f = use([[{ id: "p1", name: "Google Gemini", limits }]]);
    expect(await limitProviders()).toEqual([{ id: "p1", name: "Google Gemini", limits }]);
    expect(f.queries[0].some((c) => c.method === "where")).toBe(true);
  });

  it("keyUsage joins the grouped counts to the live keys and drops expired ones", async () => {
    use([
      [{ id: "k1", name: "a", ratePerMin: 20, expiresAt: null, lastUsedAt: NOW }, { id: "k2", name: "b", ratePerMin: 5, expiresAt: new Date(NOW.getTime() - 1), lastUsedAt: null }, { id: "k3", name: "c", ratePerMin: 5, expiresAt: null, lastUsedAt: null }],
      [{ keyId: "k1", today: "142", lastMinute: "2" }],
    ]);
    const r = await keyUsage(NOW);
    expect(r.map((x) => [x.name, x.today, x.lastMinute])).toEqual([["a", 142, 2], ["c", 0, 0]]);
  });

  it("modelRows flattens models to provider/model ids and reads the default", async () => {
    use([
      [{ id: "p1", kind: "gemini", name: "Google Gemini", enabled: true, models: [{ id: "gemini-3.8-flash", upstream: "models/gemini-3.8-flash", enabled: true, ctx: 1_000_000 }, { id: "antigravity-preview-latest", upstream: "x", enabled: false }] }],
      [{ value: "gemini/gemini-3.8-flash" }],
    ]);
    const m = await modelRows();
    expect(m.rows.map((r) => [r.publicId, r.enabled])).toEqual([["gemini/gemini-3.8-flash", true], ["gemini/antigravity-preview-latest", false]]);
    expect(m.defaultModel).toBe("gemini/gemini-3.8-flash");
  });

  it("marks manual model ids (older rows without the key are listed models)", async () => {
    use([[{ id: "p2", kind: "custom", name: "test", enabled: true, models: [{ id: "gemini-x", upstream: "gemini-x", enabled: true }, { id: "prrojects", upstream: "prrojects", enabled: true, manual: true }] }], []]);
    const m = await modelRows();
    expect(m.rows.map((r) => [r.publicId, r.manual])).toEqual([["test/gemini-x", false], ["test/prrojects", true]]);
  });

  it("a custom connection's models are prefixed with its slug, like the gateway does", async () => {
    use([[{ id: "p2", kind: "custom", name: "My Proxy", enabled: true, models: [{ id: "gemini-x", upstream: "gemini-x", enabled: true }] }], []]);
    expect((await modelRows()).rows[0].publicId).toBe("my-proxy/gemini-x");
  });

  it("setDefaultModel upserts the setting", async () => {
    const f = use([], [[]]);
    await setDefaultModel("gemini/gemini-3.8-flash", NOW);
    const w = f.writes[0];
    expect(w.table).toBe(settings);
    expect(payloadOf(w.calls)).toMatchObject({ key: "ai.defaultModel", value: "gemini/gemini-3.8-flash" });
  });
});
