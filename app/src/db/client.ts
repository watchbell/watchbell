import "server-only";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { serverEnv } from "@/lib/env";
import { mode } from "@/lib/mode";
import * as schema from "./schema";

// Driver-neutral handle: postgres.js in cloud, PGlite in self-host. Raw execute() results go through rowsOf (./rows).
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let cached: PostgresJsDatabase<typeof schema> | undefined;

// Demo: one Drizzle instance over the per-visitor facade (@/lib/demo/drizzle), which picks the visitor's in-memory PGlite
// from the request on every query. Never a DATABASE_URL, whatever it says. Loaded by ready() (instrumentation awaits it)
// so cloud and self-host never load PGlite through this module. Kept on globalThis like `local` below: Next can evaluate
// this module more than once (per layer, or again after a dev reload), and each copy must see the handle ready() set.
type DemoDb = { db?: Db };
const demo: DemoDb = ((globalThis as { __watchpostDemoDb?: DemoDb }).__watchpostDemoDb ??= {});

// Self-host without a DATABASE_URL: PGlite in WATCHBELL_DATA_DIR, opened once per process. Opening is async, so
// db() can hand it out only after ready() has finished. In the app, instrumentation register() awaits ready(), and Next
// awaits register() before it serves any request; any other entry point (a CLI script) must await ready() itself
// before calling db(). Kept on globalThis because a dev-server reload re-runs this module, and a second open of the
// same folder would be refused as "already in use".
type LocalDb = { promise?: Promise<Db>; db?: Db; close?: () => Promise<void> };
const local: LocalDb = ((globalThis as { __watchpostPglite?: LocalDb }).__watchpostPglite ??= {});

// `pglite:` is an explicit "use PGlite" sentinel: Windows can't pass an empty env var, and an empty DATABASE_URL would
// let a cloud app folder's .env.local supply the production URL.
const usesPglite = (): boolean => {
  const m = mode();
  if (m === "cloud" || m === "demo") return false;
  const url = serverEnv().DATABASE_URL;
  return !url || url.startsWith("pglite:");
};

export async function ready(): Promise<void> {
  if (mode() === "demo") {
    if (!demo.db) demo.db = (await import("@/lib/demo/drizzle")).demoDb; // repeat calls return at once
    return;
  }
  if (!usesPglite()) return;
  local.promise ??= import("./pglite")
    .then(({ dataDir, openPglite }) => openPglite(dataDir()))
    .then(
      (handle) => {
        local.close = handle.close;
        return (local.db = handle.db);
      },
      (e: unknown) => {
        local.promise = undefined; // let a later call retry, e.g. after the folder was fixed
        throw e;
      },
    );
  await local.promise;
}

// Closes the PGlite handle (flushes it and releases the folder lock). A no-op when PGlite was never opened; safe to call
// twice. Used on SIGTERM/SIGINT.
export async function closeLocalDb(): Promise<void> {
  const close = local.close;
  local.close = undefined;
  local.db = undefined;
  local.promise = undefined;
  await close?.();
}

// Transaction pooler: one connection per function instance, no prepared statements.
// With max: 1 a silently dropped connection (sleep, frozen function, pooler idle cut) would block every
// later query, so idle connections are closed early and connecting gives up instead of waiting forever.
// The Supabase pooler answers session mode on 5432 and transaction mode on 6543 (same host, user and password).
// Session mode gives each client its own server connection, so instances Vercel froze or replaced after a deploy kept
// all 15 slots busy while idle (16 Oct 2026). At runtime on Vercel the app uses transaction mode: a slot is held only
// while a query runs. Not during `next build`: both modes share the same 15 server connections, and the build waited
// forever for one while the previous production deployment (session mode) still held them all.
export function poolerUrl(url: string, onVercel: boolean, building: boolean): string {
  if (!onVercel || building) return url;
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith(".pooler.supabase.com") || (u.port !== "5432" && u.port !== "")) return url;
    u.port = "6543";
    return u.toString();
  } catch {
    return url;
  }
}

export function db(): Db {
  if (mode() === "demo") {
    if (!demo.db) throw new Error("Database not ready: call ready() first");
    return demo.db;
  }
  if (usesPglite()) {
    if (!local.db) throw new Error("Database not ready: call ready() first");
    return local.db;
  }
  if (!cached) {
    // Session mode (5432) everywhere for now: in transaction mode (6543) evaluateAlerts never returns (16 Oct incident,
    // reproduced locally); poolerUrl stays for when that is understood.
    const client = postgres(serverEnv().DATABASE_URL, {
      prepare: false,
      // One per serverless instance on Vercel. A long-lived local `next start` serves many requests at once (60 s
      // refresh, navigation, palette), and queuing them all on one pooled connection can stall, so it gets two: the
      // Supabase session pooler has only 15 client slots, shared with production (13 Oct 2026 incident).
      max: process.env.VERCEL ? 1 : 2,
      ssl: "require",
      idle_timeout: 20,
      connect_timeout: 10,
      max_lifetime: 60 * 30,
    });
    cached = drizzle({ client, schema });
  }
  return cached;
}
