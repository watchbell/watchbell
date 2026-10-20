import { beforeEach, describe, expect, it, vi } from "vitest";
import { accounts, resources } from "@/db/schema";
import { fakeDb, limitOf } from "./fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));

import { ALIAS_ACCOUNTS, ALIAS_ROWS, readAliasBook } from "./aliases-db";

beforeEach(() => {
  h.current = null;
});

const from = (calls: { method: string; args: unknown[] }[]) => calls.find((c) => c.method === "from")?.args[0];

describe("readAliasBook", () => {
  it("letters databases, apps, hosts and accounts from two bounded reads, in first-seen order", async () => {
    const answer = (calls: { method: string; args: unknown[] }[]) => from(calls) === resources ? [
      { id: "d2", kind: "neon_project", name: "ticketer", firstSeenAt: new Date("2026-10-02T00:00:00Z"), parentId: null },
      { id: "d1", kind: "supabase_project", name: "someone@gmail.com's Project", firstSeenAt: new Date("2026-10-01T00:00:00Z"), parentId: null },
      { id: "a1", kind: "app", name: "web", firstSeenAt: new Date("2026-10-01T00:00:00Z"), parentId: null },
      { id: "m1", kind: "domain", name: "web.example.com", firstSeenAt: new Date("2026-10-01T00:00:00Z"), parentId: "a1" },
    ] : from(calls) === accounts ? [{ id: "acc", label: "utama", createdAt: new Date("2026-10-01T00:00:00Z") }] : [];
    const f = fakeDb([answer, answer]);
    h.current = f;
    const book = await readAliasBook();
    expect(book.db.map((d) => [d.id, d.alias])).toEqual([["d1", "db-a"], ["d2", "db-b"]]);
    expect(book.app.map((d) => [d.id, d.alias])).toEqual([["a1", "app-a"]]);
    expect(book.account).toEqual([{ id: "acc", name: "utama", alias: "account-1" }]);
    expect(book.host?.find((x) => x.name === "web.example.com")?.alias).toBe("app-a.example");
    expect(f.queries).toHaveLength(2);
    expect(f.queries.map(limitOf).sort()).toEqual([ALIAS_ACCOUNTS, ALIAS_ROWS].sort());
    // Watched or not, gone or not: a letter never moves when a database is unticked or disappears.
    for (const q of f.queries) expect(q.some((c) => c.method === "orderBy")).toBe(true);
  });

  it("selects no credential column from accounts", async () => {
    const f = fakeDb([[], []]);
    h.current = f;
    await readAliasBook();
    const q = f.queries.find((calls) => from(calls) === accounts)!;
    expect(Object.keys(q.find((c) => c.method === "select")!.args[0] as object).sort()).toEqual(["createdAt", "id", "label"]);
  });
});

describe("readAliasBook, team slugs (M5)", () => {
  it("reads each app's team slug from its meta and letters it", async () => {
    const answer = (calls: { method: string; args: unknown[] }[]) => from(calls) === resources ? [
      { id: "a1", kind: "app", name: "web", firstSeenAt: new Date("2026-10-01T00:00:00Z"), parentId: null, team: "acme-team" },
    ] : [];
    const f = fakeDb([answer, answer]);
    h.current = f;
    const book = await readAliasBook();
    expect(book.team).toEqual([{ id: "team:acme-team", name: "acme-team", alias: "team-1" }]);
    const q = f.queries.find((calls) => from(calls) === resources)!;
    expect(Object.keys(q.find((c) => c.method === "select")!.args[0] as object)).toContain("team");
  });
});
