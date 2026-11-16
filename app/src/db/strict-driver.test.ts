import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 1.8.1: tests run on PGlite, the cloud console on postgres-js. PGlite quietly converted a JS Date in a raw sql``
// template; postgres-js (through drizzle) refuses it, and the All workspaces page broke on ops only (15 Nov). The test
// setup (test/strict-pglite.ts) makes every PGlite in the suite refuse what postgres-js refuses, so such a bug fails
// here first.
let client: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await PGlite.create();
  db = drizzle({ client });
});
afterAll(async () => client?.close());

describe("PGlite in tests behaves like postgres-js", () => {
  it("refuses a Date object where a timestamp is expected", async () => {
    await expect(db.execute(sql`select ${new Date("2026-11-01T00:00:00Z")}::timestamptz as t`)).rejects.toThrow();
  });

  it("takes an ISO string cast to timestamptz", async () => {
    const r = await db.execute(sql`select ${new Date("2026-11-01T00:00:00Z").toISOString()}::timestamptz as t`);
    expect(r.rows).toHaveLength(1);
  });

  it("refuses an object where jsonb is expected, takes JSON.stringify", async () => {
    await expect(db.execute(sql`select ${{ a: 1 }}::jsonb as j`)).rejects.toThrow();
    const r = await db.execute(sql`select ${JSON.stringify({ a: 1 })}::jsonb as j`);
    expect(r.rows).toHaveLength(1);
  });

  it("returns bigint (int8) as a string, as postgres-js does", async () => {
    const r = await db.execute(sql`select count(*) as n from (values (1), (2)) v(x)`);
    expect(r.rows[0]).toEqual({ n: "2" });
  });
});
