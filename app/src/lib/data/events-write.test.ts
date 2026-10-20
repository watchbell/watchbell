import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { fakeDb, payloadOf, whereOf } from "./fake-db";

// Same mocking pattern as audit-db.test.ts.
const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import("./fake-db").fakeDb> }));
vi.mock("@/db/client", () => ({ db: () => fake.current!.db() }));

import { recordEvents } from "./events-write";

const at = new Date("2026-10-13T12:00:00Z");
const ev = { at, resourceId: "r1", type: "monitor" as const, kind: "err" as const, message: "Monitor down", detail: "HTTP 502" };

describe("recordEvents", () => {
  it("bumps the latest matching row instead of inserting", async () => {
    fake.current = fakeDb([], [[{ id: "e1" }]]);
    await recordEvents([ev]);
    expect(fake.current.writes.map((w) => w.kind)).toEqual(["update"]);
    expect(payloadOf(fake.current.writes[0].calls)).toMatchObject({ detail: "HTTP 502", kind: "err" });
  });

  it("inserts with the derived reason when nothing matches", async () => {
    fake.current = fakeDb([], [[], []]);
    await recordEvents([ev]);
    expect(fake.current.writes.map((w) => w.kind)).toEqual(["update", "insert"]);
    expect(payloadOf(fake.current.writes[1].calls)).toMatchObject({ reason: "MonitorDown", count: 1, message: "Monitor down" });
  });

  it("never bumps an action and skips nulls", async () => {
    fake.current = fakeDb([], [[]]);
    await recordEvents([null, { ...ev, type: "action", message: "Check now: a.com/", actorUserId: "u1" }]);
    expect(fake.current.writes.map((w) => w.kind)).toEqual(["insert"]);
    expect(payloadOf(fake.current.writes[0].calls)).toMatchObject({ reason: "Action", actorUserId: "u1" });
  });

  // I5: the bump key is reason + resource + message. Provider events have no resource (null) and carry the provider in
  // the message, so "Vercel reports an incident" and "Supabase reports an incident" must not fold into one row.
  it("only bumps a row with the same message, so two providers' incidents stay two rows", async () => {
    fake.current = fakeDb([], [[], [], [], []]);
    const base = { at, resourceId: null, type: "system" as const, kind: "warn" as const, detail: "Minor outage", reason: "ProviderIncident" };
    await recordEvents([{ ...base, message: "Vercel reports an incident" }, { ...base, message: "Supabase reports an incident" }]);
    const updates = fake.current.writes.filter((w) => w.kind === "update");
    const queries = updates.map((w) => new PgDialect().sqlToQuery(whereOf(w.calls) as never));
    expect(queries[0].params).toContain("Vercel reports an incident");
    expect(queries[0].params).not.toContain("Supabase reports an incident");
    expect(queries[1].params).toContain("Supabase reports an incident");
    expect(queries[0].sql).toMatch(/message = \$\d/);
    expect(fake.current.writes.filter((w) => w.kind === "insert")).toHaveLength(2);
  });

  it("never moves last_at backwards when an older event is bumped in (M11)", async () => {
    fake.current = fakeDb([], [[{ id: "e1" }]]);
    await recordEvents([ev]);
    const set = payloadOf(fake.current.writes[0].calls) as { lastAt: { getSQL: () => unknown } };
    const q = new PgDialect().sqlToQuery(set.lastAt as never);
    expect(q.sql).toContain("greatest(");
  });
});
