// Demo builds only (WATCHBELL_MODE=demo, or the old WATCHPOST_MODE): writes demo-snapshot/migrated.tar.gz, a gzipped
// PGlite data folder with the self-host migrations applied, and demo-snapshot/migrated.json naming the migrations it was
// made from. src/lib/demo/template.ts loads it instead of migrating every visitor's database. Runs as npm's prebuild;
// any other build (cloud, self-host, the npm package) skips it. Node built-ins and the app's own dependencies only.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SNAPSHOT_FILE = "migrated.tar.gz";
export const SNAPSHOT_META = "migrated.json";

const set = (v) => (v !== undefined && v.trim() !== "" ? v.trim() : undefined);
const readEnv = (env, key) => set(env[`WATCHBELL_${key}`]) ?? set(env[`WATCHPOST_${key}`]);

// Same as migrationsHash in src/lib/demo/template.ts (template.test.ts checks they agree): the journal and every .sql,
// by name, so a snapshot is only used with the exact migrations it was made from.
export function migrationsHash(folder) {
  const hash = createHash("sha256");
  const files = ["meta/_journal.json", ...readdirSync(folder).filter((f) => f.endsWith(".sql")).sort()];
  for (const f of files) hash.update(`${f}\0`).update(readFileSync(path.join(folder, f))).update("\0");
  return hash.digest("hex");
}

export async function writeSnapshot(migrationsFolder, outDir) {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const pglite = await PGlite.create();
  try {
    await migrate(drizzle({ client: pglite }), { migrationsFolder });
    const dump = await pglite.dumpDataDir("gzip");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, SNAPSHOT_FILE), Buffer.from(await dump.arrayBuffer()));
    writeFileSync(path.join(outDir, SNAPSHOT_META), `${JSON.stringify({ migrations: migrationsHash(migrationsFolder) })}\n`);
    return dump.size;
  } finally {
    await pglite.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if ((readEnv(process.env, "MODE") ?? "").toLowerCase() !== "demo") process.exit(0);
  const migrations = path.resolve(readEnv(process.env, "MIGRATIONS_DIR") ?? "drizzle-selfhost");
  const out = path.resolve(readEnv(process.env, "DEMO_SNAPSHOT_DIR") ?? "demo-snapshot");
  const started = performance.now();
  const size = await writeSnapshot(migrations, out);
  console.log(`demo snapshot: ${path.join(out, SNAPSHOT_FILE)} (${Math.round(size / 1024)} KB, ${Math.round(performance.now() - started)} ms)`);
}
