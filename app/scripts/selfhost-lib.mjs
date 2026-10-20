// Pieces shared by the self-host launchers: scripts/start-selfhost.mjs and scripts/stop-selfhost.mjs (an installed app
// folder) and bin/watchbell.mjs (the npm package's CLI). Node built-ins only, no side effects on import.
import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";

// The PGlite lock file keeps its old name on purpose (renaming it would let an old and a new server share a folder).
export const LOCK_FILE_NAME = ".watchpost.lock";

/**
 * The environment a self-host server starts with: PGlite unless DATABASE_URL is set, the data folder from
 * WATCHBELL_DATA_DIR (or the old WATCHPOST_DATA_DIR, default ./data), and the manual signal handling the app needs to
 * close PGlite cleanly. WATCHBELL_MODE is always selfhost, whatever the source says.
 */
export function selfhostEnv(source) {
  return {
    ...source,
    WATCHBELL_MODE: "selfhost",
    DATABASE_URL: source.DATABASE_URL || "pglite:",
    NEXT_MANUAL_SIG_HANDLE: "true",
    WATCHBELL_DATA_DIR: source.WATCHBELL_DATA_DIR?.trim() || source.WATCHPOST_DATA_DIR?.trim() || "./data",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

/**
 * Shutdown: the app closes PGlite on SIGTERM/SIGINT, and a kill mid-close could corrupt it, so a launcher never kills
 * its server itself on Windows. There a graceful stop = Ctrl-C in the console (the console delivers it to the child
 * too) or the stop-request file (`npm run stop:selfhost`, `watchbell stop`); SIGTERM/SIGBREAK to the launcher just
 * waits for the child. On POSIX the first signal is forwarded once and repeats are ignored until the child exits.
 * Returns a function that removes the handlers.
 */
export function superviseChild(child, { platform = process.platform, proc = process, tty = Boolean(process.stdin.isTTY || process.stdout.isTTY) } = {}) {
  const handlers = [];
  if (platform !== "win32") {
    let forwarded = false;
    // SIGHUP: the terminal was closed. Without a handler the launcher would die at once; the server handles it too.
    // Without a terminal (nohup, a service manager) SIGHUP is ignored: Node resets nohup's inherited "ignore" to the
    // default at startup, so a hang-up would otherwise kill the launcher and the server mid-run.
    if (!tty) handlers.push(["SIGHUP", () => {}]);
    for (const sig of tty ? ["SIGTERM", "SIGINT", "SIGHUP"] : ["SIGTERM", "SIGINT"]) {
      const h = () => {
        if (forwarded) return;
        forwarded = true;
        child.kill(sig);
      };
      handlers.push([sig, h]);
    }
  } else {
    for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) handlers.push([sig, () => {}]);
  }
  for (const [sig, h] of handlers) proc.on(sig, h);
  return () => {
    for (const [sig, h] of handlers.splice(0)) proc.removeListener(sig, h);
  };
}

/** The launcher's exit code for a child that exited with `code` or was ended by `signal`. */
export const exitCodeOf = (code, signal) => code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);

/** <data>/pg/.watchpost.lock: holds the pid of the server that has the database open. */
export const lockFileOf = (dataDir) => path.join(dataDir, "pg", LOCK_FILE_NAME);

function runQuiet(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "" };
}

/**
 * The program running as `pid` ("node", "node.exe", "next-server (v16…", "chrome.exe" …), or null when it can't be
 * told. Linux: the program in /proc/<pid>/cmdline ("node", or Next's "next-server (vX)" after it renames itself),
 * else /proc/<pid>/comm (kernel threads; both are readable for other users' processes too). Not comm first: Node.js
 * names its main thread "MainThread", which is what comm shows. Windows: System32's tasklist by full path, never a
 * PATH lookup. macOS: /bin/ps.
 */
export function processNameOf(pid, { platform = process.platform, env = process.env, run = runQuiet, readFile = readFileSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "linux") {
      const argv0 = String(readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0")[0].trim();
      if (argv0) return path.posix.basename(argv0);
      return readFile(`/proc/${pid}/comm`, "utf8").trim() || null;
    }
    if (platform === "win32") {
      const tasklist = path.win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "tasklist.exe");
      const r = run(tasklist, ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"]);
      const m = r.status === 0 ? /^"([^"]+)","(\d+)"/m.exec(r.stdout) : null;
      return m && Number(m[2]) === pid ? m[1] : null;
    }
    if (platform === "darwin") {
      const r = run("/bin/ps", ["-p", String(pid), "-o", "comm="]);
      return r.status === 0 ? path.posix.basename(r.stdout.trim()) || null : null;
    }
  } catch {
    // unknown
  }
  return null;
}

/** A process name a Watchbell server can have: Node.js under any common name, or Next's renamed "next-server". */
export function looksLikeServer(name, execPath = process.execPath) {
  const base = path.win32.basename(String(name).trim()).replace(/\.exe$/i, "").toLowerCase();
  const own = path.win32.basename(String(execPath)).replace(/\.exe$/i, "").toLowerCase();
  // "mainthread": what /proc/<pid>/comm shows for Node.js on Linux; kept here so a comm fallback never calls it stale.
  return base === own || base.startsWith("node") || base.startsWith("next-server") || ["bun", "deno", "mainthread"].includes(base);
}

/**
 * Who has the database: { state: "free" } (no lock, or its process is gone); { state: "stale", pid, name } (the pid is
 * alive but is now another program: a reboot or crash left the lock and the pid was reused, e.g. "chrome.exe" or a
 * root daemon answering EPERM); { state: "held", pid, name } (alive and Node.js, or a process that could not be
 * identified, name null). `processName: null` skips the identity check.
 */
export function inspectLock(lockFile, { kill = (pid, sig) => process.kill(pid, sig), processName = (pid) => processNameOf(pid), execPath = process.execPath } = {}) {
  const free = { state: "free", pid: null, name: null };
  let pid;
  try {
    pid = Number.parseInt(readFileSync(lockFile, "utf8").trim(), 10);
  } catch {
    return free;
  }
  if (!Number.isInteger(pid) || pid <= 0) return free;
  try {
    kill(pid, 0);
  } catch (e) {
    if (e?.code !== "EPERM") return free; // EPERM: it exists, owned by someone else
  }
  const name = processName ? processName(pid) : null;
  if (name && !looksLikeServer(name, execPath)) return { state: "stale", pid, name };
  return { state: "held", pid, name };
}

/** The pid in the lock file while a Watchbell (Node.js) process holds it, else null. Options as inspectLock. */
export const lockOwner = (lockFile, opts) => {
  const info = inspectLock(lockFile, opts);
  return info.state === "held" ? info.pid : null;
};

export const lockHeld = (lockFile, opts) => lockOwner(lockFile, opts) !== null;

/** Deletes a lock that inspectLock called stale, if it still names the same pid. True when it is gone. */
export function removeStaleLock(lockFile, pid) {
  try {
    if (Number.parseInt(readFileSync(lockFile, "utf8").trim(), 10) !== pid) return false;
    unlinkSync(lockFile);
    return true;
  } catch {
    return false;
  }
}

/** What to tell someone whose lock looks held while nothing answers. */
export const staleLockHint = (lockFile) =>
  `If Watchbell is not running (for example after a crash or a power cut), delete ${lockFile} and start it again.`;

/** /api/health on the address a server bound to HOST listens on (a wildcard bind is asked on loopback). */
export function healthUrlOf(bind, port) {
  const host = bind === "0.0.0.0" ? "127.0.0.1" : bind === "::" ? "[::1]" : bind.includes(":") ? `[${bind}]` : bind;
  return `http://${host}:${port}/api/health`;
}

/** What answers at `url` within a second: null for nothing, else { status, service } (service from a JSON body). */
export async function probeHealth(url, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(1000) });
  } catch {
    return null;
  }
  let service = null;
  try {
    const body = await res.json();
    if (body && typeof body.service === "string") service = body.service;
  } catch {
    // not JSON: some other program
  }
  return { status: res.status, service };
}
