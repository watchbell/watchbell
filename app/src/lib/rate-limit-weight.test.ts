import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));

import { hitLimit } from "./rate-limit-db";

let client: PGlite;
beforeAll(async () => {
  client = await PGlite.create();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  h.db = db;
}, 60_000);
afterAll(async () => client?.close());

// 1.8.6: Alertmanager's per-source limit counts alerts, not calls: one call may carry up to 100.
describe("hitLimit with a weight", () => {
  const L = { name: "weight-test", max: 120, windowSeconds: 60 };
  it("adds the weight to the window's count and refuses once it passes the max", async () => {
    expect(await hitLimit(L, "s1", 100)).toMatchObject({ allowed: true, count: 100 });
    expect(await hitLimit(L, "s1", 20)).toMatchObject({ allowed: true, count: 120 });
    expect(await hitLimit(L, "s1", 1)).toMatchObject({ allowed: false, count: 121 });
    expect(await hitLimit(L, "s2")).toMatchObject({ allowed: true, count: 1 });
  });
});
