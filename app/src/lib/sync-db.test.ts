import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { fakeDb, payloadOf, whereOf } from "@/lib/data/fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: "k" }) }));
vi.mock("@/lib/crypto", () => ({ openOrNull: () => "token" }));
vi.mock("@/lib/providers/vercel", () => ({
  productionHost: async (_t: string, _team: string, _id: string, name: string) => ({ ok: true, data: `${name}.example.com` }),
  discoverVercel: vi.fn(), tokenExpiry: vi.fn(),
}));

import { listSyncRows, saveSelection, syncMonitors } from "./sync-db";

const app = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, externalId: `prj_${id}`, monitored: true, goneAt: null, meta: { teamId: "t1" }, ...over });
const mon = (id: string, resourceId: string, over: Record<string, unknown> = {}) => ({ id, resourceId, paused: true, ownerPaused: false, ...over });
const use = (reads: unknown[][]) => {
  const f = fakeDb(reads);
  h.current = f;
  return f;
};

beforeEach(() => {
  h.current = null;
});

describe("syncMonitors: the 20-monitor cap (final review I3)", () => {
  it("resumes what fits and leaves the rest paused by the owner's flag, counting the apps over the limit", async () => {
    const f = use([
      [app("a1"), app("a2"), app("a3")],
      [mon("m1", "a1"), mon("m2", "a2"), mon("m3", "a3")],
      [{ n: 19 }],
    ]);
    expect(await syncMonitors("acc", "token")).toBe(2);
    expect(f.executes()).toBe(1); // under the same advisory lock as Add and Resume
    expect(f.writes).toHaveLength(2);
    expect(payloadOf(f.writes[0].calls)).toEqual(expect.objectContaining({ paused: false }));
    expect(payloadOf(f.writes[0].calls)).not.toHaveProperty("ownerPaused");
    expect(payloadOf(f.writes[1].calls)).toEqual(expect.objectContaining({ paused: false, ownerPaused: true }));
  });

  it("creates default monitors past the cap owner-paused", async () => {
    const f = use([[app("a1"), app("a2")], [], [{ n: 20 }]]);
    expect(await syncMonitors("acc", "token")).toBe(2);
    expect(f.writes.map((w) => w.kind)).toEqual(["insert", "insert"]);
    expect(f.writes.map((w) => payloadOf(w.calls))).toEqual([
      { resourceId: "a1", url: "https://a1.example.com/", ownerPaused: true },
      { resourceId: "a2", url: "https://a2.example.com/", ownerPaused: true },
    ]);
  });

  it("creates them active while they fit, and reports nothing", async () => {
    const f = use([[app("a1"), app("a2")], [mon("m1", "a1", { paused: false })], [{ n: 3 }]]);
    expect(await syncMonitors("acc", "token")).toBe(0);
    expect(f.writes.map((w) => payloadOf(w.calls))).toEqual([{ resourceId: "a2", url: "https://a2.example.com/", ownerPaused: false }]);
  });

  it("never resumes a monitor the owner paused, and takes no lock when there is nothing to add or resume", async () => {
    const f = use([[app("a1")], [mon("m1", "a1", { ownerPaused: true })]]);
    expect(await syncMonitors("acc", "token")).toBe(0);
    expect(f.writes).toHaveLength(0);
    expect(f.executes()).toBe(0);
  });

  it("resumes a watched app's heartbeats outside the HTTP cap, and doesn't add a default check next to one (U3)", async () => {
    const f = use([
      [app("a1"), app("a2")],
      [mon("h1", "a1", { kind: "heartbeat" }), mon("m2", "a2"), mon("h2", "a2", { kind: "heartbeat", ownerPaused: true })],
      [{ n: 20 }],
    ]);
    expect(await syncMonitors("acc", "token")).toBe(1); // m2 is over the HTTP cap; h1 isn't counted
    const sqlOf = (calls: Parameters<typeof whereOf>[0]) => new PgDialect().sqlToQuery(whereOf(calls)!.getSQL() as never);
    expect(payloadOf(f.writes[0].calls)).toEqual(expect.objectContaining({ paused: false }));
    expect(sqlOf(f.writes[0].calls).params).toEqual(["h1"]);
    expect(f.writes.filter((w) => w.kind === "insert")).toHaveLength(0);
    expect(payloadOf(f.writes[1].calls)).toEqual(expect.objectContaining({ paused: false, ownerPaused: true }));
    expect(sqlOf(f.writes[1].calls).params).toEqual(["m2"]);
  });

  it("pauses the monitors of unwatched and gone apps without counting them", async () => {
    const f = use([[app("a1", { monitored: false }), app("a2", { goneAt: new Date() })]]);
    expect(await syncMonitors("acc", null)).toBe(0);
    expect(payloadOf(f.writes[0].calls)).toEqual(expect.objectContaining({ paused: true }));
  });
});

// I3: an account's Sync shows, saves and counts only its own kind of resource. Another kind under the same account
// (stage 4's domains under the Vercel account) is not the Sync dialog's to list or to untick.
describe("Sync is scoped to the account's resource kind", () => {
  const sql = (calls: Parameters<typeof whereOf>[0]) => new PgDialect().sqlToQuery(whereOf(calls)!.getSQL() as never);
  const row = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, kind: "supabase_project", meta: {}, monitored: true, firstSeenAt: new Date(), ...over });

  it("lists only the rows of the provider's kind", async () => {
    const f = use([[row("r1")]]);
    expect(await listSyncRows("acc", "supabase_project")).toHaveLength(1);
    const q = sql(f.queries[0]);
    expect(q.sql).toContain('"kind" = $');
    expect(q.params).toContain("supabase_project");
  });

  it("saves ticks only among that kind, both the ticked and the unticked", async () => {
    const f = use([[{ id: "acc", provider: "supabase", credentialCiphertext: "c", credentialIv: "i" }], [row("r1")]]);
    const ok = await saveSelection("acc", ["11111111-1111-4111-8111-111111111111"], false);
    expect(ok).toMatchObject({ ok: true });
    const updates = f.writes.filter((w) => w.kind === "update").slice(0, 2).map((w) => sql(w.calls));
    expect(updates).toHaveLength(2);
    for (const q of updates) {
      expect(q.sql).toContain('"kind" = $');
      expect(q.params).toContain("supabase_project");
    }
  });

  it("scopes an empty selection too, so it can't unwatch other kinds", async () => {
    const f = use([[{ id: "acc", provider: "neon", credentialCiphertext: "c", credentialIv: "i" }], []]);
    await saveSelection("acc", [], false);
    const q = sql(f.writes.find((w) => w.kind === "update")!.calls);
    expect(q.params).toContain("neon_project");
  });

  it("keeps a Vercel save among apps, so the domain rows stage 4 stores under the account are never unticked", async () => {
    const f = use([[{ id: "acc", provider: "vercel", credentialCiphertext: "c", credentialIv: "i" }], [], [], []]);
    await saveSelection("acc", [], false);
    const q = sql(f.writes.find((w) => w.kind === "update")!.calls);
    expect(q.sql).toContain('"kind" = $');
    expect(q.params).toContain("app");
    expect(q.params).not.toContain("domain");
  });

  it("scopes a Cloudflare save to zones", async () => {
    const f = use([[{ id: "acc", provider: "cloudflare", credentialCiphertext: "c", credentialIv: "i" }], []]);
    expect(await saveSelection("acc", [], false)).toMatchObject({ ok: true });
    const q = sql(f.writes.find((w) => w.kind === "update")!.calls);
    expect(q.params).toContain("zone");
  });

  it("refuses a provider with no Sync, before changing anything", async () => {
    const f = use([[{ id: "acc", provider: "drive", credentialCiphertext: "c", credentialIv: "i" }]]);
    expect(await saveSelection("acc", [], false)).toEqual({ ok: false, error: "Sync for this provider arrives in a later stage." });
    expect(f.writes).toHaveLength(0);
  });
});
