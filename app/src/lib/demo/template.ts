import "server-only";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { selfhostMigrationsFolder } from "@/db/pglite";
import { readEnv } from "@/lib/brand-env";

// Every visitor's demo database starts as the migrated self-host schema. Making that from nothing (a fresh PGlite plus
// the migrations, 1-1.5 s locally and more on a Vercel function) was most of the wait when a request reached a function
// that didn't hold the visitor's database yet. Loading a dump of an already migrated database takes 0.2-0.3 s.
//
// The dump comes from the build (scripts/demo-snapshot.mjs, demo builds only) when it was made from these exact
// migrations. Otherwise, or when it doesn't load, the first creation in the process migrates once and keeps a dump for
// the next ones. Either is kept unpacked (about 40 MB, the fastest to load).

export const SNAPSHOT_FILE = "migrated.tar.gz";
export const SNAPSHOT_META = "migrated.json";

// The journal and every .sql, by name. Same as migrationsHash in scripts/demo-snapshot.mjs (template.test.ts checks).
export function migrationsHash(folder: string): string {
  const hash = createHash("sha256");
  const files = ["meta/_journal.json", ...readdirSync(folder).filter((f) => f.endsWith(".sql")).sort()];
  for (const f of files) hash.update(`${f}\0`).update(readFileSync(join(folder, f))).update("\0");
  return hash.digest("hex");
}

// WATCHBELL_DEMO_SNAPSHOT_DIR (or the old WATCHPOST_ name), else ./demo-snapshot from the working directory (the app
// root under next start and on Vercel). next.config.ts traces the folder into the server output.
export function demoSnapshotDir(source: Record<string, string | undefined> = process.env): string {
  return resolve(/*turbopackIgnore: true*/ readEnv(source, "DEMO_SNAPSHOT_DIR") || "demo-snapshot");
}

type Template = { blob: Blob; from: "build" | "process" };
type Holder = { __watchbellDemoTemplate?: Promise<Template> };
const holder = globalThis as Holder;

function fromBuild(migrationsFolder: string): Template | null {
  const dir = demoSnapshotDir();
  try {
    const meta = JSON.parse(readFileSync(join(dir, SNAPSHOT_META), "utf8")) as { migrations?: unknown };
    if (meta.migrations !== migrationsHash(migrationsFolder)) return null;
    // Unpacked here: a damaged gzip fails in this try, where PGlite's own unpacking also throws outside its promise.
    return { blob: new Blob([gunzipSync(readFileSync(join(dir, SNAPSHOT_FILE)))], { type: "application/x-tar" }), from: "build" };
  } catch {
    return null; // no snapshot (any build but the demo's), or an unreadable or damaged one
  }
}

async function fromMigrations(migrationsFolder: string): Promise<Template> {
  const pglite = await PGlite.create();
  try {
    await migrate(drizzle({ client: pglite }), { migrationsFolder });
    return { blob: await pglite.dumpDataDir("none"), from: "process" };
  } finally {
    await pglite.close();
  }
}

function remember(p: Promise<Template>): Promise<Template> {
  holder.__watchbellDemoTemplate = p;
  p.catch(() => {
    if (holder.__watchbellDemoTemplate === p) delete holder.__watchbellDemoTemplate; // the next creation tries again
  });
  return p;
}

function template(): Promise<Template> {
  if (holder.__watchbellDemoTemplate) return holder.__watchbellDemoTemplate;
  const started = performance.now();
  const folder = selfhostMigrationsFolder();
  const built = fromBuild(folder);
  const p = remember(built ? Promise.resolve(built) : fromMigrations(folder));
  void p.then((t) => console.info(`demo: schema template ${t.from === "build" ? "read from the build's snapshot" : "migrated in this process"} in ${Math.round(performance.now() - started)} ms`), () => undefined);
  return p;
}

// A new in-memory PGlite holding the migrated, still empty self-host schema.
export async function createMigratedPglite(): Promise<PGlite> {
  const current = template();
  const t = await current;
  try {
    return await PGlite.create({ loadDataDir: t.blob });
  } catch (e) {
    if (t.from !== "build") throw e;
    if (holder.__watchbellDemoTemplate === current) {
      console.warn(`demo: the build's migrated snapshot didn't load (${e instanceof Error ? e.message : String(e)}); migrating instead`);
      remember(fromMigrations(selfhostMigrationsFolder()));
    }
    return PGlite.create({ loadDataDir: (await template()).blob });
  }
}

export function resetDemoTemplateForTests(): void {
  if (!process.env.VITEST) throw new Error("resetDemoTemplateForTests is for tests only");
  delete holder.__watchbellDemoTemplate;
}
