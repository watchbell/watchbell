import "server-only";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { readEnv } from "@/lib/brand-env";
import type { Db } from "./client";
import * as schema from "./schema";

// Self-host without a DATABASE_URL: an in-process PGlite (Postgres compiled to WASM) kept in a local folder, with the
// squashed baseline in ./drizzle-selfhost generated from the same Drizzle schema (npm run db:generate:selfhost).

export class DataDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataDirError";
  }
}

export function dataDir(source: Record<string, string | undefined> = process.env): string {
  return resolve(/*turbopackIgnore: true*/ readEnv(source, "DATA_DIR") || "./data", "pg");
}

// Resolved from the working directory (the app root under `next start`, `next dev` and vitest), because bundling would
// rewrite a module-relative path. WATCHBELL_MIGRATIONS_DIR (or the old WATCHPOST_MIGRATIONS_DIR) overrides it for
// installs started from another folder. The ignore comments keep Next from tracing the whole project into the server output because of these runtime paths.
export function selfhostMigrationsFolder(source: Record<string, string | undefined> = process.env): string {
  const folder = resolve(/*turbopackIgnore: true*/ readEnv(source, "MIGRATIONS_DIR") || "drizzle-selfhost");
  if (!existsSync(join(folder, "meta", "_journal.json"))) {
    throw new Error(`Watchbell can't find its database migrations in ${folder}. Start it from the app folder or set WATCHBELL_MIGRATIONS_DIR.`);
  }
  return folder;
}

const LOCK_FILE = ".watchpost.lock";

// Folders this process holds open. A lock naming this process's own pid but a folder not in here was left by an earlier
// process that had the same pid (a container's pid 1 after a restart, or one killed before it could clean up).
const claimed = new Set<string>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

// The launchers (bin/watchbell.mjs, scripts/start-selfhost.mjs) remove a lock whose pid now belongs to another program
// before the server starts; a lock a live process still names is the user's call, so the message says which file it is.
const inUse = (dir: string, lock: string) =>
  new DataDirError(
    `Another Watchbell is already using ${dir}. Stop it first. If Watchbell is not running (for example after a crash or a power cut), delete ${lock} and start it again.`,
  );

// PGlite does not refuse a second opener of the same folder (checked with 0.5.8: a second instance opens it and answers
// queries while the first is still open), so the folder is claimed with a lock file holding the owner's pid. This is
// the only place that decides "already in use": a lock whose pid is still running and, for our own pid, that we hold.
function claimFolder(dir: string): () => void {
  const lock = join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new DataDirError(`Watchbell can't write its data folder: ${dir}`);
      const owner = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
      const held = owner === process.pid ? claimed.has(dir) : Number.isInteger(owner) && owner > 0 && alive(owner);
      if (held) throw inUse(dir, lock);
      unlinkSync(lock); // stale: left behind by a process that is gone
      continue;
    }
    claimed.add(dir);
    const release = () => {
      process.off("exit", release);
      claimed.delete(dir);
      try {
        unlinkSync(lock);
      } catch {
        // already gone
      }
    };
    process.on("exit", release);
    return release;
  }
  throw inUse(dir, lock);
}

export async function openPglite(dir: string): Promise<{ db: Db; close(): Promise<void> }> {
  const folder = resolve(dir);
  try {
    mkdirSync(folder, { recursive: true });
  } catch {
    throw new DataDirError(`Watchbell can't write its data folder: ${folder}`);
  }
  const release = claimFolder(folder);
  let client: PGlite | undefined;
  try {
    client = await PGlite.create(folder);
    const db = drizzle({ client, schema });
    await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
    const open = client;
    return {
      db,
      async close() {
        try {
          await open.close();
        } finally {
          release();
        }
      },
    };
  } catch (e) {
    await client?.close().catch(() => undefined);
    release();
    throw e;
  }
}
