import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, payloadOf } from "./fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));

import { recordAction } from "./audit-db";

beforeEach(() => {
  h.current = null;
});

describe("recordAction", () => {
  it("writes one event of type action with the actor's user id", async () => {
    const f = fakeDb([]);
    h.current = f;
    await recordAction({ kind: "ok", message: "Monitor added: web.example.com/", resourceId: "a1", actorUserId: "user-1" });
    expect(f.writes.map((w) => w.kind)).toEqual(["insert"]);
    expect(payloadOf(f.writes[0].calls)).toMatchObject({
      type: "action", kind: "ok", message: "Monitor added: web.example.com/", resourceId: "a1", actorUserId: "user-1", detail: null,
    });
  });

  it("keeps an optional detail", async () => {
    const f = fakeDb([]);
    h.current = f;
    await recordAction({ kind: "err", message: "Check now: x/", detail: "was y/", resourceId: null, actorUserId: "u" });
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ kind: "err", detail: "was y/", resourceId: null });
  });

  it("throws if the write fails, so the caller decides what a missing entry means", async () => {
    h.current = fakeDb([], [new Error("db down")]);
    await expect(recordAction({ kind: "ok", message: "m", resourceId: null, actorUserId: "u" })).rejects.toThrow("db down");
  });
});
