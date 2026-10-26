import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { resources } from "@/db/schema";
import { fakeDb, payloadOf } from "@/lib/data/fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));

import { recordProductionSources } from "./production-source-db";

// Watchbell 1.2.2 (D15): the Vercel task records what the live production deployment was built from, and when.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";
const SHA = "abcdef1234567890abcdef1234567890abcdef12";
const now = new Date("2026-10-25T10:00:00Z");
const at = now.toISOString();
const ago = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
const paramsOf = (calls: Parameters<typeof payloadOf>[0]) => {
  const meta = payloadOf(calls)?.meta as { getSQL: () => unknown };
  return new PgDialect().sqlToQuery(meta.getSQL() as never).params;
};

beforeEach(() => { h.current = null; });

describe("recordProductionSources", () => {
  it("writes a changed source with its deployment and time; skips one read lately and an app without a current deployment", async () => {
    const f = fakeDb([[
      { app: A, id: "dpl_a", source: "cli", branch: null, sha: null },
      { app: B, id: "dpl_b", source: "git", branch: "web-revamp", sha: SHA },
      { app: D, id: "dpl_d", source: "git", branch: null, sha: null },
    ]]);
    h.current = f;
    const n = await recordProductionSources([
      { id: A, meta: { productionBranch: "main" } },
      { id: B, meta: { productionSource: { kind: "git", ref: "web-revamp", sha: SHA, at: ago(3), id: "dpl_b" } } },
      { id: C, meta: { productionSource: { kind: "cli", at: ago(3) } } },
      { id: D, meta: { productionSource: { kind: "git", ref: "main", at: ago(3) } } },
    ], now);
    // A written; D's new current deployment names no source, so its old reading loses its time (fix round 4, minor 2a).
    expect(n).toBe(2);
    expect(f.writes.map((w) => w.table)).toEqual([resources, resources]);
    expect(paramsOf(f.writes[0].calls)).toContain(JSON.stringify({ productionSource: { kind: "cli", id: "dpl_a", at } }));
    expect(paramsOf(f.writes[1].calls)).toContain(JSON.stringify({ productionSource: { kind: "git", ref: "main" } }));
  });

  // Fix round 4 (re-review r3 minor 2): a reading of another deployment confirms nothing about the current one.
  describe("the current deployment's source can't be established", () => {
    it("a redeploy not read this run (no meta): the old reading of another deployment loses its time, once", async () => {
      const f = fakeDb([[{ app: A, id: "dpl_redeploy", source: "redeploy", branch: "main", sha: SHA }]]);
      h.current = f;
      expect(await recordProductionSources([{ id: A, meta: { productionSource: { kind: "git", ref: "main", sha: SHA, at: ago(2), id: "dpl_old" } } }], now)).toBe(1);
      expect(paramsOf(f.writes[0].calls)).toContain(JSON.stringify({ productionSource: { kind: "git", ref: "main", sha: SHA, id: "dpl_old" } }));
      // Already without a time: nothing written again.
      const g = fakeDb([[{ app: A, id: "dpl_redeploy", source: "redeploy", branch: "main", sha: SHA }]]);
      h.current = g;
      expect(await recordProductionSources([{ id: A, meta: { productionSource: { kind: "git", ref: "main", sha: SHA, id: "dpl_old" } } }], now)).toBe(0);
      expect(g.writes).toEqual([]);
    });
    it("Vercel's own 'git' or 'cli' on a row not read this run is still trusted; nothing stored and nothing known stays unrecorded", async () => {
      const f = fakeDb([[{ app: A, id: "dpl_g", source: "git", branch: "main", sha: SHA }, { app: B, id: "dpl_p", source: "promote", branch: "main", sha: SHA }]]);
      h.current = f;
      expect(await recordProductionSources([{ id: A, meta: { productionSource: { kind: "cli", at: ago(2), id: "dpl_old" } } }, { id: B, meta: {} }], now)).toBe(1);
      expect(paramsOf(f.writes[0].calls)).toContain(JSON.stringify({ productionSource: { kind: "git", ref: "main", sha: SHA, id: "dpl_g", at } }));
    });
  });

  it("renews the time of an unchanged source after 10 minutes, and of one stored without a time", async () => {
    const f = fakeDb([[{ app: A, id: "dpl_a", source: "git", branch: "main", sha: SHA }, { app: B, id: "dpl_b", source: "cli", branch: null, sha: null }]]);
    h.current = f;
    expect(await recordProductionSources([
      { id: A, meta: { productionSource: { kind: "git", ref: "main", sha: SHA, at: ago(11), id: "dpl_a" } } },
      { id: B, meta: { productionSource: { kind: "cli", id: "dpl_b" } } },
    ], now)).toBe(2);
    expect(paramsOf(f.writes[0].calls)).toContain(JSON.stringify({ productionSource: { kind: "git", ref: "main", sha: SHA, id: "dpl_a", at } }));
  });

  it("a new production deployment from another branch replaces the stored source", async () => {
    const f = fakeDb([[{ app: A, id: "dpl_new", source: "git", branch: "main", sha: SHA }]]);
    h.current = f;
    expect(await recordProductionSources([{ id: A, meta: { productionSource: { kind: "cli", at: ago(1), id: "dpl_old" } } }], now)).toBe(1);
    expect(paramsOf(f.writes[0].calls)).toContain(JSON.stringify({ productionSource: { kind: "git", ref: "main", sha: SHA, id: "dpl_new", at } }));
  });

  // Fix round 3 (re-review r2 I1): a redeploy or promote of a CLI deployment keeps only the CLI's git metadata.
  it("a redeploy whose branch came only from the CLI's metadata (seen this run) is a CLI deploy; so is a dirty tree", async () => {
    const f = fakeDb([[
      { app: A, id: "dpl_r", source: "redeploy", branch: "main", sha: SHA },
      { app: B, id: "dpl_d", source: "git", branch: "main", sha: SHA },
      { app: C, id: "dpl_g", source: "redeploy", branch: "main", sha: SHA },
    ]]);
    h.current = f;
    const seen = new Map([["dpl_r", { branchFrom: "cli" }], ["dpl_d", { branchFrom: "github", gitDirty: true }], ["dpl_g", { branchFrom: "github" }]]);
    expect(await recordProductionSources([{ id: A, meta: {} }, { id: B, meta: {} }, { id: C, meta: {} }], now, seen)).toBe(3);
    expect(paramsOf(f.writes[0].calls)).toContain(JSON.stringify({ productionSource: { kind: "cli", ref: "main", sha: SHA, id: "dpl_r", at } }));
    expect(paramsOf(f.writes[1].calls)).toContain(JSON.stringify({ productionSource: { kind: "cli", ref: "main", sha: SHA, id: "dpl_d", at } }));
    expect(paramsOf(f.writes[2].calls)).toContain(JSON.stringify({ productionSource: { kind: "git", ref: "main", sha: SHA, id: "dpl_g", at } }));
  });

  it("the same deployment not read this run keeps the kind stored for it (only the time is renewed)", async () => {
    const f = fakeDb([[{ app: A, id: "dpl_r", source: "redeploy", branch: "main", sha: SHA }]]);
    h.current = f;
    expect(await recordProductionSources([{ id: A, meta: { productionSource: { kind: "cli", ref: "main", sha: SHA, at: ago(12), id: "dpl_r" } } }], now)).toBe(1);
    expect(paramsOf(f.writes[0].calls)).toContain(JSON.stringify({ productionSource: { kind: "cli", ref: "main", sha: SHA, id: "dpl_r", at } }));
  });

  it("no apps: nothing read", async () => {
    const f = fakeDb([]);
    h.current = f;
    expect(await recordProductionSources([], now)).toBe(0);
    expect(f.queries).toEqual([]);
  });
});
