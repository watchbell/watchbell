// Starts the self-host server with safe defaults: PGlite (never an inherited DATABASE_URL), a ./data folder, and the
// manual signal handling the app needs to close PGlite cleanly. Run from the app folder after `npm run build`.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exitCodeOf, inspectLock, lockFileOf, removeStaleLock, selfhostEnv, superviseChild } from "./selfhost-lib.mjs";

// app/.env (next to this script's folder, whatever the cwd) fills in what the environment does not already set, so its
// HOST and PORT reach `next start` below (Next itself loads .env only after the port is chosen). Variables already in
// the environment win (loadEnvFile never overrides), so systemd's EnvironmentFile and explicit values keep precedence.
// app/.env.local is never loaded here.
const dotenv = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

// WATCHBELL_* is what the app reads first; the old WATCHPOST_DATA_DIR in an existing app/.env still counts.
const env = selfhostEnv(process.env);

// A database lock left by a crash or power cut whose pid now belongs to another program (not Node.js) would make the
// server refuse to start forever (and a service restart it in a loop): remove it. One a Node.js process holds stays.
const lockFile = lockFileOf(path.resolve(env.WATCHBELL_DATA_DIR));
const lock = inspectLock(lockFile);
if (lock.state === "stale" && removeStaleLock(lockFile, lock.pid)) {
  console.log(`Removed a leftover database lock (${lockFile}): process ${lock.pid} is now ${lock.name}, not Watchbell.`);
}

const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(process.execPath, [next, "start", "-H", process.env.HOST || "127.0.0.1", "-p", process.env.PORT || "3100"], {
  env,
  stdio: "inherit",
});
// Graceful stop rules (forward once on POSIX, never kill on Windows): see superviseChild in selfhost-lib.mjs.
superviseChild(child);
child.on("exit", (code, signal) => process.exit(exitCodeOf(code, signal)));
