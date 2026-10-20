import { existsSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { readEnv } from "./brand-env";

// Clean stop for a self-host server: stop the background jobs, close PGlite, exit 0. Next only leaves SIGTERM/SIGINT to
// the app when NEXT_MANUAL_SIG_HANDLE=true. Runs once however many signals or stop requests arrive.
export type ShutdownDeps = {
  stops: Array<() => void>;
  closeDb: () => Promise<void>;
  exit: (code: number) => void;
};

export function createShutdown({ stops, closeDb, exit }: ShutdownDeps): () => Promise<void> {
  let running: Promise<void> | undefined;
  return () =>
    (running ??= (async () => {
      let code = 0;
      for (const stop of stops) {
        try {
          stop();
        } catch {
          code = 1;
        }
      }
      try {
        await closeDb();
      } catch {
        code = 1;
      }
      exit(code);
    })());
}

// <WATCHBELL_DATA_DIR>/stop-request, resolved like the rest of the selfhost files (from the working directory, the app
// folder under npm run start:selfhost). `npm run stop:selfhost` writes it: the graceful stop on Windows, where a hidden
// server gets no Ctrl+C and Stop-ScheduledTask is a hard kill.
export function stopRequestFile(source: Record<string, string | undefined> = process.env): string {
  return resolve(/*turbopackIgnore: true*/ readEnv(source, "DATA_DIR") || "./data", "stop-request");
}

// When this process started (ms since epoch).
export function processStartedAt(): number {
  return Date.now() - process.uptime() * 1000;
}

// Polls for the stop-request file (unref'd timer, so it never keeps the process alive). A file older than this server
// (its mtime before startedAt minus a small margin) is a leftover and is removed first, so it cannot stop a fresh
// server; a request written while the server was starting up stays and stops it at the first poll. When the file
// appears it is deleted and shutdown runs, once. Returns a function that stops the polling.
export function watchStopRequest(opts: {
  file: string;
  shutdown: () => Promise<void>;
  intervalMs?: number;
  startedAt?: number;
  marginMs?: number;
}): () => void {
  const { file, shutdown, intervalMs = 1000, startedAt = processStartedAt(), marginMs = 2000 } = opts;
  const remove = () => {
    try {
      rmSync(file, { force: true });
    } catch {
      // unreadable folder: the next poll tries again
    }
  };
  try {
    if (statSync(file).mtimeMs < startedAt - marginMs) remove();
  } catch {
    // no file: nothing left over
  }
  const timer = setInterval(() => {
    if (!existsSync(file)) return;
    clearInterval(timer);
    remove();
    void shutdown();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

// Wires the clean stop to SIGTERM/SIGINT. Lives here, not in instrumentation.ts, which Next also compiles for the edge
// runtime (where process.on/process.exit don't exist and the build warns about them); instrumentation-node.ts imports
// this, and instrumentation.ts loads that only inside its NEXT_RUNTIME === "nodejs" check.
// With stopRequestFile it also watches that file (every platform) and runs the same, once-only shutdown. signals: false
// leaves SIGTERM/SIGINT to Next (it handles them itself unless NEXT_MANUAL_SIG_HANDLE=true).
export function installSignalHandlers(opts: {
  stops: Array<() => void>;
  closeDb: () => Promise<void>;
  signals?: boolean;
  stopRequestFile?: string;
  tty?: boolean;
}): void {
  const { stops, closeDb, signals = true, stopRequestFile: file } = opts;
  const shutdown = createShutdown({ stops, closeDb, exit: (code) => process.exit(code) });
  if (file) watchStopRequest({ file, shutdown });
  if (!signals) return;
  // on, not once: a second signal while closing must not fall back to the default (instant) termination. The shutdown
  // guard makes repeats harmless. SIGHUP: the terminal it runs in was closed (on Windows: its console window); the
  // default would end the process at once, mid-close of PGlite.
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  // Only with a controlling terminal. Under `nohup` (or a service manager) a hang-up is ignored: Node resets nohup's
  // inherited "ignore" to the default at startup, so without this no-op the server would die when the terminal closes.
  if (opts.tty ?? Boolean(process.stdin.isTTY || process.stdout.isTTY)) process.on("SIGHUP", () => void shutdown());
  else process.on("SIGHUP", () => {});
}
