// The Node.js half of register() (instrumentation.ts), loaded only inside its NEXT_RUNTIME === "nodejs" check so the
// Edge bundle never includes this file or what it imports (PGlite, node:fs, the demo's node:crypto, the shutdown code).
// Cloud (WATCHBELL_MODE unset) does nothing: in cloud the clock is cron-job.org / QStash / Vercel cron. Demo refuses any
// DATABASE_URL but pglite:, installs the outbound fetch guard and starts no clock (every visitor gets a throwaway
// in-memory database). Selfhost refuses a hosted Supabase DATABASE_URL, opens the database, then runs its own scheduler
// and Telegram poller.
// A process-wide flag keeps them from starting twice (a second register() in the same process, e.g. a dev reload).
import { readEnv } from "@/lib/brand-env";

type Started = { __watchpostClockStarted?: boolean };

// Demo never reads or writes a real database and never calls a real provider. Stricter than selfhost on purpose and with
// no override: only an unset DATABASE_URL or the pglite: sentinel is accepted (not even a self-managed Postgres).
async function startDemo(): Promise<void> {
  const url = (process.env.DATABASE_URL ?? "").trim();
  if (url !== "" && !url.toLowerCase().startsWith("pglite:")) {
    throw new Error("Refusing to start: WATCHBELL_MODE=demo never uses a real database. Unset DATABASE_URL or set DATABASE_URL=pglite:.");
  }
  (await import("@/lib/demo/fetch-guard")).installFetchGuard();
  // Opens nothing: prepares db()'s per-visitor handle (each visitor's in-memory database is created on first use).
  await (await import("@/db/client")).ready();
}

export async function registerNode(): Promise<void> {
  const { mode, remoteDbRisk } = await import("@/lib/mode");
  if (mode() === "demo") return startDemo();
  if (mode() !== "selfhost") return;
  // A selfhost server started from the cloud app folder inherits .env.local's DATABASE_URL, which is production: refuse
  // to boot at all (also for odd URLs: unparsable, no host, several hosts) rather than serve (or write to) it. Use DATABASE_URL=pglite: for the local database.
  if (remoteDbRisk() && readEnv(process.env, "ALLOW_REMOTE_DB") !== "1") {
    throw new Error(
      "Refusing to start: WATCHBELL_MODE=selfhost with a remote or unrecognised DATABASE_URL. Use DATABASE_URL=pglite: or set WATCHBELL_ALLOW_REMOTE_DB=1.",
    );
  }
  const { ready, closeLocalDb } = await import("@/db/client");
  await ready();
  if ((globalThis as Started).__watchpostClockStarted) return;
  (globalThis as Started).__watchpostClockStarted = true;
  // First run: while nobody owns the console, print a one-time code for /setup (stored hashed, valid 24 h).
  try {
    const [{ ensureSetupCode }, { serverEnv }] = await Promise.all([import("@/lib/local-auth/setup"), import("@/lib/env")]);
    const env = serverEnv();
    await ensureSetupCode({ key: Buffer.from(env.OPS_ENCRYPTION_KEY, "base64"), siteUrl: env.SITE_URL });
  } catch (e) {
    const { logCause } = await import("@/lib/collector/safe-error");
    console.warn(`Watchbell setup code could not be prepared: ${logCause(e)}`);
  }
  const { startScheduler } = await import("@/lib/scheduler/scheduler");
  const scheduler = startScheduler();
  const { startTelegramPoller } = await import("@/lib/notify/telegram-poll");
  const poller = startTelegramPoller();
  console.log("Watchbell scheduler started (collector every 60 s, daily at 03:00 WIB)");
  // The same once-only clean stop for SIGTERM/SIGINT (when Next leaves them to the app) and, on every platform, for the
  // stop-request file that `npm run stop:selfhost` writes (Windows has no graceful signal for a hidden server).
  const { installSignalHandlers, stopRequestFile } = await import("@/lib/shutdown");
  installSignalHandlers({
    stops: [() => scheduler.stop(), () => poller.stop()],
    closeDb: closeLocalDb,
    signals: process.env.NEXT_MANUAL_SIG_HANDLE === "true",
    stopRequestFile: stopRequestFile(),
  });
}
