import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, limitOf } from "./fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));

import { paletteSource } from "./palette-db";

const use = (results: unknown[][]) => {
  const f = fakeDb(results);
  h.current = f;
  return f;
};

beforeEach(() => {
  h.current = null;
});

describe("paletteSource", () => {
  it("returns apps with their domain and monitors with their path, in three bounded queries", async () => {
    const f = use([
      [{ id: "a1", name: "web" }, { id: "a2", name: "api" }],
      [],
      [
        { id: "m1", appId: "a1", url: "https://web.example.com/api/health?x=1" },
        { id: "m2", appId: "a1", url: "https://web.example.com/" },
      ],
    ]);
    const src = await paletteSource();
    expect(src.apps).toEqual([
      { id: "a1", name: "web", domain: "web.example.com" },
      { id: "a2", name: "api", domain: "api.vercel.app" },
    ]);
    expect(src.monitors).toEqual([
      { id: "m1", appId: "a1", appName: "web", path: "/api/health" },
      { id: "m2", appId: "a1", appName: "web", path: "/" },
    ]);
    expect(f.queries.map(limitOf)).toEqual([200, 200, 200]);
  });

  it("shows a heartbeat by its name, and takes the domain from an HTTP check only (U3)", async () => {
    use([
      [{ id: "a1", name: "web" }],
      [],
      [
        { id: "h1", appId: "a1", url: "heartbeat:backup-job", kind: "heartbeat", name: "backup job" },
        { id: "m1", appId: "a1", url: "https://web.example.com/", kind: "http", name: null },
      ],
    ]);
    const src = await paletteSource();
    expect(src.apps).toEqual([{ id: "a1", name: "web", domain: "web.example.com" }]);
    expect(src.monitors[0]).toEqual({ id: "h1", appId: "a1", appName: "web", path: " · backup job" });
  });

  it("skips the monitor query when nothing is watched", async () => {
    const f = use([[]]);
    expect(await paletteSource()).toEqual({ apps: [], monitors: [], domains: [] });
    expect(f.queries).toHaveLength(2);
  });

  it("lists the watched domains of watched apps (or of none), skipping those of an unwatched app", async () => {
    const f = use([
      [{ id: "a1", name: "web" }],
      [
        { id: "d1", name: "web.example.com", parentId: "a1" },
        { id: "d2", name: "orphan.example.org", parentId: null },
        { id: "d3", name: "old.example.net", parentId: "a9" },
      ],
      [],
    ]);
    const src = await paletteSource();
    expect(src.domains).toEqual([{ id: "d1", name: "web.example.com" }, { id: "d2", name: "orphan.example.org" }]);
    // Same filter as the Domains page: watched, not gone; capped like the apps and monitors.
    expect(limitOf(f.queries[1])).toBe(200);
  });

  it("still lists a parentless domain when no app is watched", async () => {
    use([[], [{ id: "d2", name: "orphan.example.org", parentId: null }]]);
    expect((await paletteSource()).domains).toEqual([{ id: "d2", name: "orphan.example.org" }]);
  });
});
