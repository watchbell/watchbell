import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, limitOf, whereOf } from "@/lib/data/fake-db";
import { buildAliasBook } from "@/lib/view/display-name";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown }, resolveApp: vi.fn(), aliasBook: vi.fn() }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("./snapshot", () => ({ resolveApp: h.resolveApp }));
vi.mock("@/lib/data/cached", () => ({ aliasBook: h.aliasBook }));

import { adviceFor } from "./advice";

const now = new Date("2026-10-13T12:00:00Z");
const book = buildAliasBook([{ id: "db-1", kind: "supabase_project", name: "atlas-main", firstSeenAt: "2026-01-01T00:00:00Z" }]);
const note = (o: Record<string, unknown> = {}) => ({
  id: "n1", severity: "warn", title: "Database is paused", body: "atlas-main is paused. Restore it; mail owner@example.com", source: "antigravity", model: "gemini-3.8-flash",
  createdAt: new Date("2026-10-13T08:00:00Z"), ...o,
});

beforeEach(() => {
  vi.resetAllMocks();
  h.aliasBook.mockResolvedValue(book);
  h.resolveApp.mockResolvedValue({ id: "app-uuid", name: "acme-shop" });
});

describe("adviceFor", () => {
  it("is null for an unknown app and reads no notes", async () => {
    h.resolveApp.mockResolvedValue(null);
    const f = fakeDb([]);
    h.current = f;
    expect(await adviceFor("nope", now)).toBeNull();
    expect(f.queries).toHaveLength(0);
  });

  it("returns the newest 5 non-dismissed notes of the app, matched by id or name", async () => {
    const f = fakeDb([[note(), note({ id: "n2", createdAt: new Date("2026-10-12T08:00:00Z") })]]);
    h.current = f;
    const r = await adviceFor("ACME-SHOP", now);
    expect(h.resolveApp).toHaveBeenCalledWith("ACME-SHOP", now);
    expect(r?.app).toBe("acme-shop");
    expect(r?.notes.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(limitOf(f.queries[0])).toBe(5);
    const q = new PgDialect().sqlToQuery(whereOf(f.queries[0])!.getSQL() as never);
    expect(q.sql).toMatch(/"dismissed_at" is null/);
    expect(q.sql).toMatch(/"app_id" in \(\$1, \$2\)/);
    expect(q.params).toEqual(["app-uuid", "acme-shop"]);
    const order = f.queries[0].find((c) => c.method === "orderBy");
    expect(new PgDialect().sqlToQuery((order!.args[0] as { getSQL: () => unknown }).getSQL() as never).sql).toMatch(/"created_at" desc/);
  });

  it("scrubs the note text (database aliases, emails) and keeps who wrote it", async () => {
    h.current = fakeDb([[note()]]);
    const r = await adviceFor("acme-shop", now);
    expect(r?.notes[0]).toEqual({
      id: "n1", severity: "warn", title: "Database is paused", body: "db-a is paused. Restore it; mail [email]", source: "antigravity", model: "gemini-3.8-flash",
      createdAt: "2026-10-13T08:00:00.000Z",
    });
  });

  it("answers an empty list for an app with no notes", async () => {
    h.current = fakeDb([[]]);
    expect(await adviceFor("acme-shop", now)).toEqual({ app: "acme-shop", notes: [] });
  });
});
