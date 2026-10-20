import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import { rowsOf } from "@/db/rows";
import * as schema from "@/db/schema";

// Demo mode, Auto-actions (Task 5 of the demo plan): the seeded proposals show on the page, approving one runs a
// simulated action (an audit entry in the visitor's database, no provider call) and rejecting works as usual.
const h = vi.hoisted(() => ({ db: undefined as unknown, member: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));
vi.mock("@/lib/auth", () => ({ requireActionMember: async () => h.member }));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => { void fn(); } }));

import { demoUserId, seedDemoDb } from "@/lib/demo/seed";
import { memberRowId } from "@/lib/demo/seed/members";
import { SIMULATED_NOTE } from "@/lib/demo/simulate";
import { decideProposalAction } from "./page-actions";
import { listProposals } from "./proposals-db";

const SEED = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const SAVED = process.env.WATCHPOST_MODE;
const fetchSpy = vi.fn(async () => new Response("{}"));
const realFetch = globalThis.fetch;
let client: PGlite;

beforeAll(async () => {
  client = await PGlite.create();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  await seedDemoDb(db, SEED, new Date(Date.now() - 60_000), "visitor@example.com");
  h.db = db;
}, 120_000);
afterAll(async () => {
  await client.close();
});
beforeEach(() => {
  process.env.WATCHPOST_MODE = "demo";
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  h.member = { id: memberRowId(SEED), userId: demoUserId(SEED), email: "visitor@example.com", role: "owner" };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (SAVED === undefined) delete process.env.WATCHPOST_MODE;
  else process.env.WATCHPOST_MODE = SAVED;
});

describe("demo: Auto-actions", () => {
  it("lists the four seeded proposals, pending first", async () => {
    const list = await listProposals(new Date(), 20);
    expect(list.map((p) => `${p.status}/${p.risk}`)).toEqual(expect.arrayContaining(["pending/safe", "pending/risky", "done/safe", "rejected/risky"]));
    expect(list.slice(0, 2).every((p) => p.status === "pending")).toBe(true);
  });

  it("approving a risky proposal runs a simulated action: done, audited, nothing sent", async () => {
    const risky = (await listProposals(new Date(), 20)).find((p) => p.status === "pending" && p.risk === "risky")!;
    expect(await decideProposalAction(risky.id, "approve")).toEqual({ ok: true, message: SIMULATED_NOTE });
    const [row] = rowsOf<{ status: string; result: string; decided_by: string }>(await (h.db as ReturnType<typeof drizzle>).execute(sql`select status, result, decided_by from ops.action_proposals where id = ${risky.id}::uuid`));
    expect(row).toEqual({ status: "done", result: SIMULATED_NOTE, decided_by: memberRowId(SEED) });
    const audit = rowsOf<{ message: string }>(await (h.db as ReturnType<typeof drizzle>).execute(sql`select message from ops.events where type = 'action' and detail = 'Simulated in the demo'`));
    expect(audit.map((a) => a.message)).toEqual(["Redeploy production (simulated)"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejecting works as usual", async () => {
    const safe = (await listProposals(new Date(), 20)).find((p) => p.status === "pending" && p.risk === "safe")!;
    expect(await decideProposalAction(safe.id, "reject")).toEqual({ ok: true, message: "Rejected." });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
