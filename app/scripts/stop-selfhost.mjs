// Graceful stop for a self-host server (`npm run stop:selfhost`, run from the app folder). Windows has no clean signal
// for a hidden server (Stop-ScheduledTask is a hard kill, which could catch PGlite mid-close), so this writes
// <WATCHBELL_DATA_DIR>/stop-request; the server polls for it every second and runs its normal clean stop (jobs, PGlite,
// exit 0). Then it waits until /api/health stops answering and the database lock is gone.
// Exit codes: 0 stopped (or not running), 1 still running after the timeout, 2 bad arguments.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { healthUrlOf, inspectLock, lockFileOf, probeHealth, staleLockHint } from "./selfhost-lib.mjs";

const appDir = fileURLToPath(new URL("..", import.meta.url));
// Same settings as start-selfhost.mjs: app/.env fills in what the environment does not set (never app/.env.local).
const dotenv = path.join(appDir, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

let timeoutSec = 30;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--timeout" && /^\d{1,4}$/.test(argv[i + 1] ?? "") && Number(argv[i + 1]) > 0) timeoutSec = Number(argv[++i]);
  else if (a === "--help" || a === "-h") {
    console.log("Usage: npm run stop:selfhost [-- --timeout <seconds>]   (default 30)");
    process.exit(0);
  } else {
    console.error(`stop-selfhost: unknown argument ${a}. Usage: npm run stop:selfhost [-- --timeout <seconds>]`);
    process.exit(2);
  }
}

// The server resolves WATCHBELL_DATA_DIR (or the old WATCHPOST_DATA_DIR) from its working directory, which is the app
// folder when it was started with npm run start:selfhost or the installers' service/task.
const dataDir = path.resolve(appDir, process.env.WATCHBELL_DATA_DIR?.trim() || process.env.WATCHPOST_DATA_DIR?.trim() || "./data");
const requestFile = path.join(dataDir, "stop-request");
const lockFile = lockFileOf(dataDir);
const healthUrl = healthUrlOf(process.env.HOST || "127.0.0.1", process.env.PORT || "3100");

// A lock whose pid now belongs to another program (a reboot or crash left it, the pid was reused) does not count.
const running = async () => inspectLock(lockFile).state === "held" || (await probeHealth(healthUrl)) !== null;

if (!(await running())) {
  console.log(`Watchbell is not running (nothing answers at ${healthUrl} and ${dataDir} is not in use).`);
  process.exit(0);
}

mkdirSync(dataDir, { recursive: true });
writeFileSync(requestFile, `${new Date().toISOString()}\n`);
console.log(`Asked Watchbell to stop; waiting up to ${timeoutSec} s for it to close its database...`);
const deadline = Date.now() + timeoutSec * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  if (!(await running())) {
    console.log("Watchbell stopped.");
    process.exit(0);
  }
}
rmSync(requestFile, { force: true });
const lock = inspectLock(lockFile);
if (lock.state === "held" && (await probeHealth(healthUrl)) === null) {
  // Nothing answers, yet the lock names a live Node.js process: an unrelated one that got the pid of a server that
  // died without cleaning up, or a server that hangs. Say exactly which file holds things up.
  console.error(
    `Watchbell did not stop within ${timeoutSec} s. Nothing answers at ${healthUrl}, but the database lock ${lockFile} ` +
      `names process ${lock.pid}${lock.name ? ` (${lock.name})` : ""}, which is still running. ${staleLockHint(lockFile)}`,
  );
  process.exit(1);
}
console.error(
  `Watchbell did not stop within ${timeoutSec} s. If it runs as the Windows Scheduled Task, force it in PowerShell with ` +
    "Stop-ScheduledTask Watchbell (a hard stop; an install from before the rename that kept its task: Stop-ScheduledTask " +
    "Watchpost); if it runs in a window, press Ctrl+C there.",
);
process.exit(1);
