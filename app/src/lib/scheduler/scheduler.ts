import { logCause } from "@/lib/collector/safe-error";

// Selfhost has no cron-job.org / QStash / Vercel cron, so the app runs its own clock: the collector every minute and the
// daily job once a day at 03:00 WIB. A missed day (laptop asleep) runs once on wake-up, never twice.

const WIB_OFFSET_MS = 7 * 3_600_000;
const DAILY_HOUR_WIB = 3;
const FIRST_TICK_MS = 5_000;
const LAST_DAILY_KEY = "scheduler.lastDaily"; // ops.settings: { day: "YYYY-MM-DD" in WIB }

const wibParts = (now: Date) => {
  const iso = new Date(now.getTime() + WIB_OFFSET_MS).toISOString();
  return { day: iso.slice(0, 10), hour: Number(iso.slice(11, 13)) };
};

// True when the WIB date of `now` is not `lastDay` and it is already 03:00 WIB or later on that date.
export function dailyDue(now: Date, lastDay: string | null): boolean {
  const { day, hour } = wibParts(now);
  return day !== lastDay && hour >= DAILY_HOUR_WIB;
}

export type SchedulerDeps = {
  tick?: number;
  now?: () => Date;
  minute?: () => Promise<unknown>;
  daily?: () => Promise<unknown>;
  readLastDay?: () => Promise<string | null>;
  writeLastDay?: (d: string) => Promise<void>;
  setInterval?: typeof setInterval;
};

// The real deps load the database and the runners lazily, so importing this module stays free of both.
async function readLastDayFromDb(): Promise<string | null> {
  const [{ eq }, { db }, { settings }] = await Promise.all([import("drizzle-orm"), import("@/db/client"), import("@/db/schema")]);
  const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, LAST_DAILY_KEY)).limit(1);
  const day = (row?.value as { day?: unknown } | undefined)?.day;
  return typeof day === "string" ? day : null;
}
async function writeLastDayToDb(day: string): Promise<void> {
  const [{ db }, { settings }] = await Promise.all([import("@/db/client"), import("@/db/schema")]);
  const value = { day };
  await db().insert(settings).values({ key: LAST_DAILY_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

// Self-host's daily job: the shared daily run plus housekeeping only self-host has. The scheduler never runs in cloud
// (register() starts it in selfhost only), so cloud's /api/daily is untouched. Session rows that ended without anyone
// presenting their cookie again are deleted here; a failed sweep is logged and never fails the daily run.
export async function selfhostDaily(run: () => Promise<unknown>, sweepSessions: () => Promise<number>): Promise<unknown> {
  try {
    const n = await sweepSessions();
    if (n > 0) console.log(`scheduler: removed ${n} ended session${n === 1 ? "" : "s"}`);
  } catch (e) {
    console.warn(`scheduler: session sweep failed: ${logCause(e)}`);
  }
  return run();
}

export function startScheduler(deps: SchedulerDeps = {}): { stop(): void } {
  const tickMs = deps.tick ?? 60_000;
  const now = deps.now ?? (() => new Date());
  const minute = deps.minute ?? (async () => (await import("@/lib/collector/runners")).runMinute("builtin"));
  const daily =
    deps.daily ??
    (() =>
      selfhostDaily(
        async () => (await import("@/lib/collector/runners")).runDailyAll(),
        async () => (await import("@/lib/local-auth/sessions-db")).deleteExpiredLocalSessions(),
      ));
  const readLastDay = deps.readLastDay ?? readLastDayFromDb;
  const writeLastDay = deps.writeLastDay ?? writeLastDayToDb;
  const every = deps.setInterval ?? setInterval;

  let minuteRunning = false;
  let dailyRunning = false;
  let stopped = false;

  const runMinute = async () => {
    if (minuteRunning) return; // the previous run outlived the tick: skip, never overlap
    minuteRunning = true;
    try {
      await minute();
    } catch (e) {
      console.warn(`scheduler: collector run failed: ${logCause(e)}`);
    } finally {
      minuteRunning = false;
    }
  };

  const runDaily = async () => {
    if (dailyRunning) return;
    dailyRunning = true;
    try {
      const at = now();
      if (!dailyDue(at, await readLastDay())) return;
      await daily();
      await writeLastDay(wibParts(at).day);
    } catch (e) {
      console.warn(`scheduler: daily run failed, will retry on the next tick: ${logCause(e)}`);
    } finally {
      dailyRunning = false;
    }
  };

  const tick = () => {
    if (stopped) return;
    void runMinute();
    void runDaily();
  };

  const first = setTimeout(tick, FIRST_TICK_MS);
  first.unref?.();
  const timer = every(tick, tickMs);
  (timer as { unref?: () => void }).unref?.();

  return {
    stop() {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
