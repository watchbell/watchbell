import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { links } from "@/db/schema";
import { fakeDb, limitOf, payloadOf, whereOf } from "./fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));

import { databaseOptions, linkedDatabases, listDatabases, saveLink, supabaseSlotInputs } from "./databases-db";

const use = (results: unknown[][], writes: (unknown[] | Error)[] = []) => {
  const f = fakeDb(results, writes);
  h.current = f;
  return f;
};

const APP = "123e4567-e89b-42d3-a456-426614174000";
const DB = "223e4567-e89b-42d3-a456-426614174000";

beforeEach(() => {
  h.current = null;
});

describe("listDatabases", () => {
  it("reads at most 200 watched databases and the apps linked to them, and nothing more when there are none", async () => {
    const f = use([[]]);
    expect(await listDatabases("neon_project")).toEqual([]);
    expect(f.queries).toHaveLength(1);
    expect(limitOf(f.queries[0])).toBe(200);
  });

  it("joins each database with its snapshot, account and linked apps; a missing snapshot reads unknown", async () => {
    const f = use([
      [
        { r: { id: "d1", name: "portfolio", externalId: "ref1" }, s: { state: "ok", stateSince: null, collectedAt: null, data: { status: "ACTIVE_HEALTHY" } }, account: "utama" },
        { r: { id: "d2", name: "acme-shop", externalId: "ref2" }, s: null, account: "kedua" },
      ],
      [{ dbId: "d1", id: "a1", name: "web-portfolio" }],
    ]);
    const rows = await listDatabases("supabase_project");
    expect(limitOf(f.queries[1])).toBe(200);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "d1", account: "utama", state: "ok", usedBy: [{ id: "a1", name: "web-portfolio" }] });
    expect(rows[1]).toMatchObject({ id: "d2", account: "kedua", state: "unknown", data: {}, usedBy: [] });
  });
});

describe("supabaseSlotInputs", () => {
  it("counts unwatched projects from the last Sync, and lends a watched project's plan to its org", async () => {
    use([[
      { r: { name: "portfolio", meta: {} }, s: { data: { status: "ACTIVE_HEALTHY", orgSlug: "org-a", freeOrg: true } }, account: "utama" },
      { r: { name: "quillpad", meta: { status: "INACTIVE", orgSlug: "org-a" } }, s: null, account: "utama" },
      { r: { name: "ai-dev", meta: {} }, s: null, account: "kedua" },
    ]]);
    expect(await supabaseSlotInputs()).toEqual([
      { account: "utama", name: "portfolio", status: "ACTIVE_HEALTHY", freeOrg: true },
      { account: "utama", name: "quillpad", status: "INACTIVE", freeOrg: true },
      { account: "kedua", name: "ai-dev", status: "UNKNOWN", freeOrg: null },
    ]);
  });
});

describe("databaseOptions / linkedDatabases", () => {
  it("lists watched databases of any provider, bounded", async () => {
    const f = use([[{ id: "d1", name: "portfolio", kind: "supabase_project", externalId: "ref1", account: "utama", data: { region: "ap-southeast-1" } }]]);
    expect(await databaseOptions()).toEqual([{ id: "d1", name: "portfolio", kind: "supabase_project", account: "utama", region: "ap-southeast-1", ident: "ref ref1" }]);
    expect(limitOf(f.queries[0])).toBe(200);
  });

  it("asks nothing for no apps, and maps an app to its database (unknown when it has no snapshot)", async () => {
    const f = use([[{ app: "a1", id: "d1", externalId: "ref1", name: "portfolio", kind: "supabase_project", account: "utama", state: null }]]);
    expect(await linkedDatabases([])).toEqual(new Map());
    expect(f.queries).toHaveLength(0);
    expect(await linkedDatabases(["a1"])).toEqual(new Map([["a1", { id: "d1", externalId: "ref1", name: "portfolio", kind: "supabase_project", account: "utama", state: "unknown" }]]));
  });
});

describe("only watched things count (I1, M4)", () => {
  const sql = (calls: Parameters<typeof whereOf>[0]) => new PgDialect().sqlToQuery(whereOf(calls)!.getSQL() as never);

  it("linkedDatabases leaves out a database that was unticked or is gone, so its frozen state shows nowhere", async () => {
    const f = use([[]]);
    await linkedDatabases(["a1"]);
    const q = sql(f.queries[0]);
    expect(q.sql).toContain('"monitored" = $');
    expect(q.params).toContain(true);
    expect(q.sql).toContain('"gone_at" is null');
  });

  it("saveLink only links an app the console still watches", async () => {
    const f = use([[]]);
    expect(await saveLink(APP, DB, "user-1")).toEqual({ ok: false, error: "That app is no longer in the console." });
    const q = sql(f.queries[0]);
    expect(q.sql).toContain('"monitored" = $');
    expect(q.sql).toContain('"gone_at" is null');
  });
});

describe("saveLink", () => {
  it("refuses an app the console doesn't have", async () => {
    const f = use([[]]);
    expect(await saveLink(APP, DB, "user-1")).toEqual({ ok: false, error: "That app is no longer in the console." });
    expect(f.writes).toHaveLength(0);
  });

  it("refuses a database that isn't watched any more, before changing anything", async () => {
    const f = use([[{ id: APP, name: "web-Quillpad" }], []]);
    expect(await saveLink(APP, DB, "user-1")).toEqual({ ok: false, error: "That database isn't watched any more. Tick it in Sync first." });
    expect(f.writes).toHaveLength(0);
  });

  it("replaces the app's one uses_db link with a manual one and audits it with the acting user", async () => {
    const f = use([[{ id: APP, name: "web-Quillpad" }], [{ id: DB, name: "quillpad", kind: "supabase_project" }]]);
    expect(await saveLink(APP, DB, "user-1")).toEqual({ ok: true, message: "web-Quillpad now uses quillpad (Supabase)." });
    expect(f.writes.map((w) => [w.kind, w.table])).toEqual([["delete", links], ["insert", links], ["insert", expect.anything()]]);
    expect(payloadOf(f.writes[1].calls)).toEqual({ fromResourceId: APP, toResourceId: DB, kind: "uses_db", source: "manual" });
    expect(payloadOf(f.writes[2].calls)).toMatchObject({ type: "action", kind: "ok", resourceId: APP, actorUserId: "user-1", message: "Database link: web-Quillpad → quillpad" });
  });

  it("removes the link when none is chosen", async () => {
    const f = use([[{ id: APP, name: "web-Quillpad" }]]);
    expect(await saveLink(APP, null, "user-1")).toEqual({ ok: true, message: "web-Quillpad has no database linked." });
    expect(f.writes.map((w) => w.kind)).toEqual(["delete", "insert"]);
    expect(payloadOf(f.writes[1].calls)).toMatchObject({ message: "Database link removed: web-Quillpad" });
  });

  it("still saves the link when the audit entry can't be written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    use([[{ id: APP, name: "web-Quillpad" }]], [[], new Error("db down")]);
    expect(await saveLink(APP, null, "user-1")).toEqual({ ok: true, message: "web-Quillpad has no database linked." });
    warn.mockRestore();
  });
});
