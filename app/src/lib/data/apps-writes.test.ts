import { beforeEach, describe, expect, it, vi } from "vitest";
import { appSecurity, deployments, events, monitors, resources, snapshots } from "@/db/schema";
import { fakeDb, payloadOf } from "./fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));

import { removeApp } from "./apps-db";

// The fake has no transaction(): run the callback against the same recorder.
const use = (results: unknown[][]) => {
  const f = fakeDb(results);
  const inner = f.db();
  h.current = { db: () => ({ ...inner, transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(inner) }) };
  return f;
};

beforeEach(() => { h.current = null; });

describe("removeApp", () => {
  it("unwatches the app, deletes only its console rows, and audits it", async () => {
    const f = use([[{ id: "a1", name: "portfolio-site" }]]);
    const r = await removeApp("a1", "u1");
    expect(r).toEqual({ ok: true, message: "portfolio-site is no longer in the console. The Vercel project itself isn't touched." });

    const changes = f.writes.filter((w) => w.kind !== "insert");
    // Every update/delete is scoped by a WHERE, and exactly these tables change, in this order (the last delete is the app's domain rows).
    expect(changes.every((w) => w.calls.some((c) => c.method === "where"))).toBe(true);
    expect(changes.map((w) => [w.kind, w.table])).toEqual([
      ["update", resources], ["delete", monitors], ["delete", deployments], ["delete", snapshots], ["delete", appSecurity], ["delete", resources],
    ]);
    expect(payloadOf(changes[0].calls)).toMatchObject({ monitored: false });

    // Events are never deleted or updated; the only events write is the audit insert.
    const onEvents = f.writes.filter((w) => w.table === events);
    expect(onEvents.map((w) => w.kind)).toEqual(["insert"]);
    expect(payloadOf(onEvents[0].calls)).toMatchObject({
      type: "action", kind: "ok", message: "portfolio-site removed from the console", resourceId: "a1", actorUserId: "u1", reason: "Action", count: 1,
    });
    expect(f.writes).toHaveLength(7);
  });

  it("says so when the app is already gone, and writes nothing", async () => {
    const f = use([[]]);
    const r = await removeApp("a1", "u1");
    expect(r).toEqual({ ok: false, error: "That app is no longer in the console." });
    expect(f.writes).toEqual([]);
  });
});
