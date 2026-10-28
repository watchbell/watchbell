import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import { tmpBase } from "../../../test/tmp-base";
import * as script from "../../../scripts/demo-snapshot.mjs";
import { SNAPSHOT_FILE, SNAPSHOT_META, createMigratedPglite, migrationsHash, resetDemoTemplateForTests } from "./template";

// The demo's visitor databases start from a dump of the migrated schema: the build's (scripts/demo-snapshot.mjs) when
// it matches the migrations, else one migrated once per process. Either way a visitor gets the full schema.
const root = join(tmpBase, `demo-template-${process.pid}-${Date.now()}`);
const saved = process.env.WATCHBELL_DEMO_SNAPSHOT_DIR;

async function tables(): Promise<number> {
  const pglite = await createMigratedPglite();
  try {
    return (await pglite.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_schema = 'ops'")).rows[0].n;
  } finally {
    await pglite.close();
  }
}

let expected = 0;
beforeAll(async () => {
  mkdirSync(root, { recursive: true });
  process.env.WATCHBELL_DEMO_SNAPSHOT_DIR = join(root, "none");
  resetDemoTemplateForTests();
  expected = await tables(); // migrated in this process
}, 120_000);

afterEach(() => {
  resetDemoTemplateForTests();
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (saved === undefined) delete process.env.WATCHBELL_DEMO_SNAPSHOT_DIR;
  else process.env.WATCHBELL_DEMO_SNAPSHOT_DIR = saved;
  await rm(root, { recursive: true, force: true });
});

describe("demo template", () => {
  it("hashes the migrations the same way as the build script", () => {
    const folder = selfhostMigrationsFolder();
    expect(script.migrationsHash(folder)).toBe(migrationsHash(folder));
    expect(script.SNAPSHOT_FILE).toBe(SNAPSHOT_FILE);
    expect(script.SNAPSHOT_META).toBe(SNAPSHOT_META);
  });

  it("without a build snapshot migrates once and every visitor database has the schema", async () => {
    expect(expected).toBeGreaterThan(10);
    expect(await tables()).toBe(expected);
  }, 60_000);

  it("loads the build's snapshot when it matches the migrations", async () => {
    const dir = join(root, "built");
    await script.writeSnapshot(selfhostMigrationsFolder(), dir);
    process.env.WATCHBELL_DEMO_SNAPSHOT_DIR = dir;
    const create = vi.spyOn((await import("@electric-sql/pglite")).PGlite, "create");
    expect(await tables()).toBe(expected);
    expect(create).toHaveBeenCalledTimes(1); // no separate instance to migrate
    expect(create.mock.calls[0][0]).toMatchObject({ loadDataDir: expect.any(Blob) });
  }, 120_000);

  it("ignores a snapshot made from other migrations", async () => {
    const dir = join(root, "stale");
    await script.writeSnapshot(selfhostMigrationsFolder(), dir);
    writeFileSync(join(dir, SNAPSHOT_META), JSON.stringify({ migrations: "0".repeat(64) }));
    process.env.WATCHBELL_DEMO_SNAPSHOT_DIR = dir;
    const create = vi.spyOn((await import("@electric-sql/pglite")).PGlite, "create");
    expect(await tables()).toBe(expected);
    expect(create.mock.calls[0][0]).toBeUndefined(); // migrated from scratch
  }, 120_000);

  it("migrates instead when the build's snapshot is damaged", async () => {
    const folder = selfhostMigrationsFolder();
    const dir = join(root, "damaged");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SNAPSHOT_FILE), "not gzip");
    writeFileSync(join(dir, SNAPSHOT_META), JSON.stringify({ migrations: migrationsHash(folder) }));
    process.env.WATCHBELL_DEMO_SNAPSHOT_DIR = dir;
    const create = vi.spyOn((await import("@electric-sql/pglite")).PGlite, "create");
    expect(await tables()).toBe(expected);
    expect(create.mock.calls[0][0]).toBeUndefined();
  }, 120_000);

  it("falls back to migrating when the build's snapshot doesn't load", async () => {
    const folder = selfhostMigrationsFolder();
    const dir = join(root, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SNAPSHOT_FILE), gzipSync("not a tarball"));
    writeFileSync(join(dir, SNAPSHOT_META), JSON.stringify({ migrations: migrationsHash(folder) }));
    process.env.WATCHBELL_DEMO_SNAPSHOT_DIR = dir;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await tables()).toBe(expected);
    expect(warn.mock.calls.filter(([m]) => String(m).includes("migrating instead"))).toHaveLength(1);
    expect(await tables()).toBe(expected); // the fallback is kept: no second warning
    expect(warn).toHaveBeenCalledTimes(1);
  }, 120_000);
});
