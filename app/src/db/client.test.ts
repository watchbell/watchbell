import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({ url: "", localDb: { kind: "pglite" }, opened: [] as string[], closed: 0 }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ DATABASE_URL: h.url }) }));
vi.mock("./pglite", () => ({
  dataDir: () => "/data/pg",
  openPglite: async (dir: string) => {
    h.opened.push(dir);
    return { db: h.localDb, close: async () => { h.closed++; } };
  },
}));

import { poolerUrl } from "./client";

const SESSION = "postgresql://ops_app.ref:pw@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres";
const TX = SESSION.replace(":5432/", ":6543/");

describe("poolerUrl", () => {
  it("moves the Supabase pooler to transaction mode (6543) at runtime on Vercel", () => {
    expect(poolerUrl(SESSION, true, false)).toBe(TX);
  });
  it("keeps session mode during next build, off Vercel, for other hosts and when already on 6543", () => {
    expect(poolerUrl(SESSION, true, true)).toBe(SESSION);
    expect(poolerUrl(SESSION, false, false)).toBe(SESSION);
    expect(poolerUrl("postgresql://u:p@db.example.com:5432/postgres", true, false)).toBe("postgresql://u:p@db.example.com:5432/postgres");
    expect(poolerUrl(TX, true, false)).toBe(TX);
    expect(poolerUrl("not a url", true, false)).toBe("not a url");
  });
});

describe("db() and ready()", () => {
  const fresh = async () => {
    delete (globalThis as { __watchpostPglite?: unknown }).__watchpostPglite;
    delete (globalThis as { __watchpostDemoDb?: unknown }).__watchpostDemoDb;
    vi.resetModules();
    return import("./client");
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    h.url = "";
    h.opened = [];
  });

  it("cloud: ready() resolves without opening PGlite and db() is postgres.js", async () => {
    vi.stubEnv("WATCHPOST_MODE", "");
    h.url = "postgresql://u:p@db.example.com:5432/postgres";
    const client = await fresh();
    await client.ready();
    expect(h.opened).toEqual([]);
    expect(client.db()).not.toBe(h.localDb);
  });

  it("self-host with a DATABASE_URL uses it, not PGlite", async () => {
    vi.stubEnv("WATCHPOST_MODE", "selfhost");
    h.url = "postgresql://u:p@db.example.com:5432/postgres";
    const client = await fresh();
    await client.ready();
    expect(h.opened).toEqual([]);
    expect(client.db()).not.toBe(h.localDb);
  });

  it("self-host with the pglite: sentinel opens PGlite, cloud with it never does", async () => {
    vi.stubEnv("WATCHPOST_MODE", "selfhost");
    h.url = "pglite:";
    const client = await fresh();
    await client.ready();
    expect(h.opened).toEqual(["/data/pg"]);
    expect(client.db()).toBe(h.localDb);
  });

  it("closeLocalDb closes the PGlite handle once and is a no-op afterwards", async () => {
    vi.stubEnv("WATCHPOST_MODE", "selfhost");
    h.closed = 0;
    const client = await fresh();
    await client.closeLocalDb();
    expect(h.closed).toBe(0);
    await client.ready();
    await client.closeLocalDb();
    await client.closeLocalDb();
    expect(h.closed).toBe(1);
  });

  it("self-host without one opens PGlite once, and db() refuses until ready() resolved", async () => {
    vi.stubEnv("WATCHPOST_MODE", "selfhost");
    const client = await fresh();
    expect(() => client.db()).toThrow("Database not ready: call ready() first");
    await Promise.all([client.ready(), client.ready()]);
    await client.ready();
    expect(h.opened).toEqual(["/data/pg"]);
    expect(client.db()).toBe(h.localDb);
  });

  it("demo: db() refuses until ready(), which opens nothing; then it is the per-visitor facade whatever DATABASE_URL says", async () => {
    for (const url of ["", "pglite:", "postgresql://u:p@db.example.com:5432/postgres"]) {
      vi.stubEnv("WATCHPOST_MODE", "demo");
      h.url = url;
      const client = await fresh();
      expect(() => client.db()).toThrow("Database not ready: call ready() first");
      await Promise.all([client.ready(), client.ready()]);
      expect(h.opened).toEqual([]);
      const { demoPglite } = await import("@/lib/demo/facade");
      expect((client.db() as unknown as { $client: unknown }).$client).toBe(demoPglite);
      expect(client.db()).toBe(client.db());
    }
  });

  it("demo: a second copy of this module (Next evaluates it per layer) sees the db() that ready() prepared", async () => {
    vi.stubEnv("WATCHPOST_MODE", "demo");
    const first = await fresh();
    await first.ready();
    vi.resetModules(); // a new module instance, same process
    const second = await import("./client");
    expect(second).not.toBe(first);
    expect(second.db()).toBe(first.db());
    await second.ready(); // cheap and idempotent: keeps the same handle
    expect(second.db()).toBe(first.db());
  });
});
