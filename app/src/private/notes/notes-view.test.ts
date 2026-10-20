import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, limitOf, payloadOf } from "@/lib/data/fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));

import { dismiss, listNotes, NOTES_MAX } from "./notes-view";

const NOW = new Date("2026-10-13T03:00:00.000Z");
const APP = "123e4567-e89b-42d3-a456-426614174000";
const row = (o: Record<string, unknown> = {}) => ({
  id: "n1", appId: APP, severity: "crit", title: "orbit-blog: down", body: "Roll back.", source: "antigravity", client: "antigravity/1.4",
  model: "gemini-3.8-flash", createdAt: new Date("2026-10-13T01:00:00.000Z"), ...o,
});

beforeEach(() => { h.current = null; });

describe("listNotes", () => {
  it("Overview: every live note, capped at 20, with app names resolved in one extra read", async () => {
    const f = fakeDb([[row(), row({ id: "n2", appId: null, client: null })], [{ id: APP, name: "orbit-blog" }]]);
    h.current = f;
    const list = await listNotes(undefined, NOW);
    expect(limitOf(f.queries[0])).toBe(NOTES_MAX);
    expect(list.map((n) => [n.id, n.appName, n.from, n.model])).toEqual([["n1", "orbit-blog", "antigravity/1.4", "gemini-3.8-flash"], ["n2", null, "antigravity", "gemini-3.8-flash"]]);
  });
  it("shows a name an agent stored instead of the id", async () => {
    h.current = fakeDb([[row({ appId: "orbit-blog" })]]);
    expect((await listNotes(undefined, NOW))[0].appName).toBe("orbit-blog");
  });
  it("an app's page: matches the id and the name, no name lookup afterwards", async () => {
    const f = fakeDb([[{ name: "orbit-blog" }], [row()]]);
    h.current = f;
    const list = await listNotes(APP, NOW);
    expect(list).toHaveLength(1);
    expect(list[0].appName).toBe("orbit-blog");
    expect(f.queries).toHaveLength(2);
  });
  it("a malformed app id reads nothing", async () => {
    const f = fakeDb([]);
    h.current = f;
    expect(await listNotes("not-a-uuid", NOW)).toEqual([]);
    expect(f.queries).toHaveLength(0);
  });
});

describe("dismiss", () => {
  it("marks one live note dismissed by the member and returns what the audit needs", async () => {
    const f = fakeDb([], [[{ id: "n1", title: "T", appId: APP, source: "antigravity", client: null }]]);
    h.current = f;
    expect(await dismiss("n1", "user-1", NOW)).toEqual({ id: "n1", title: "T", appId: APP, from: "antigravity" });
    expect(payloadOf(f.writes[0].calls)).toEqual({ dismissedAt: NOW, dismissedBy: "user-1" });
  });
  it("is null for a missing or already dismissed note", async () => {
    h.current = fakeDb([], [[]]);
    expect(await dismiss("n1", "user-1", NOW)).toBeNull();
  });
});
