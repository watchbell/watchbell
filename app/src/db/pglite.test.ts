import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { tmpBase } from "../../test/tmp-base";
import { rowsOf } from "./rows";
import { DataDirError, dataDir, openPglite, selfhostMigrationsFolder } from "./pglite";

// Scratch space: tmpBase (test/tmp-base.ts, off drive C when possible). Only this run's folder is removed afterwards.
const root = join(tmpBase, `pglite-test-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });
// A PGlite folder holds many small files; removing them on Windows can take longer than the default 10 s.
afterAll(() => rm(root, { recursive: true, force: true }), 120_000);

describe("dataDir", () => {
  it("defaults to ./data/pg, resolved", () => {
    expect(dataDir({})).toBe(resolve("./data/pg"));
  });
  it("follows WATCHBELL_DATA_DIR, else the old WATCHPOST_DATA_DIR", () => {
    expect(dataDir({ WATCHBELL_DATA_DIR: join(root, "custom") })).toBe(join(root, "custom", "pg"));
    expect(dataDir({ WATCHPOST_DATA_DIR: join(root, "custom") })).toBe(join(root, "custom", "pg"));
    expect(dataDir({ WATCHBELL_DATA_DIR: join(root, "new"), WATCHPOST_DATA_DIR: join(root, "old") })).toBe(join(root, "new", "pg"));
  });
});

describe("selfhostMigrationsFolder", () => {
  it("defaults to ./drizzle-selfhost and follows WATCHPOST_MIGRATIONS_DIR", () => {
    expect(selfhostMigrationsFolder({})).toBe(resolve("drizzle-selfhost"));
    expect(selfhostMigrationsFolder({ WATCHPOST_MIGRATIONS_DIR: resolve("drizzle-selfhost") })).toBe(resolve("drizzle-selfhost"));
    expect(selfhostMigrationsFolder({ WATCHBELL_MIGRATIONS_DIR: resolve("drizzle-selfhost"), WATCHPOST_MIGRATIONS_DIR: join(root, "old") })).toBe(resolve("drizzle-selfhost"));
  });
  it("says where it looked when the folder is missing", () => {
    const missing = join(root, "no-migrations");
    expect(() => selfhostMigrationsFolder({ WATCHPOST_MIGRATIONS_DIR: missing })).toThrow(
      `Watchbell can't find its database migrations in ${missing}. Start it from the app folder or set WATCHBELL_MIGRATIONS_DIR.`,
    );
  });
});

describe("openPglite", () => {
  it("creates the folder, applies the baseline and answers queries", async () => {
    const dir = join(root, "fresh", "pg");
    const handle = await openPglite(dir);
    try {
      expect(existsSync(dir)).toBe(true);
      expect(rowsOf<{ one: number }>(await handle.db.execute(sql`select 1 as one`))).toEqual([{ one: 1 }]);
      const tables = rowsOf(await handle.db.execute(sql`select 1 from information_schema.tables where table_schema = 'ops' and table_name = 'members'`));
      expect(tables).toHaveLength(1);
    } finally {
      await handle.close();
    }
  }, 120_000);

  it("refuses a folder it cannot create", async () => {
    const file = join(root, "a-file");
    writeFileSync(file, "x");
    const dir = join(file, "pg");
    const err = await openPglite(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataDirError);
    expect((err as Error).message).toBe(`Watchbell can't write its data folder: ${dir}`);
  });

  it("refuses a folder another open database holds, and frees it on close", async () => {
    const dir = join(root, "shared", "pg");
    const first = await openPglite(dir);
    try {
      const err = await openPglite(dir).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DataDirError);
      expect((err as Error).message).toBe(
        `Another Watchbell is already using ${dir}. Stop it first. If Watchbell is not running (for example after a crash or a power cut), delete ${join(dir, ".watchpost.lock")} and start it again.`,
      );
    } finally {
      await first.close();
    }
    expect(existsSync(join(dir, ".watchpost.lock"))).toBe(false);
    const again = await openPglite(dir);
    await again.close();
  }, 120_000);

  it("takes over a lock left by a process that is gone", async () => {
    const dir = join(root, "stale", "pg");
    mkdirSync(dir, { recursive: true });
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(join(dir, ".watchpost.lock"), String(gone));
    const handle = await openPglite(dir);
    await handle.close();
  }, 120_000);

  it("takes over a lock with this process's pid that this process does not hold (pid reused after a restart)", async () => {
    const dir = join(root, "reused-pid", "pg");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".watchpost.lock"), String(process.pid));
    const handle = await openPglite(dir);
    try {
      const err = await openPglite(dir).catch((e: unknown) => e);
      expect((err as Error).message).toBe(
        `Another Watchbell is already using ${dir}. Stop it first. If Watchbell is not running (for example after a crash or a power cut), delete ${join(dir, ".watchpost.lock")} and start it again.`,
      );
    } finally {
      await handle.close();
    }
  }, 120_000);
});
