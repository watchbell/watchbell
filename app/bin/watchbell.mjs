#!/usr/bin/env node
// The `watchbell` command of the npm package (built by the private repo's scripts/export/pack.mjs from the public
// export). The package holds a prebuilt Next.js standalone server in server/, so an install never runs a build, and it
// never writes inside its own folder: settings live in ~/.watchbell/.env and the database in ~/.watchbell/data
// (WATCHBELL_HOME moves both). Node built-ins only. Everything that touches the machine comes in through `deps`, so the
// tests (bin/watchbell.test.mjs) run every command against stubs.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
// The default import, not { parseEnv }: on an old Node.js a missing named export fails before any code runs, and the
// "needs Node.js 24" message below would never print.
import util from "node:util";
import {
  exitCodeOf,
  healthUrlOf,
  inspectLock,
  lockFileOf,
  probeHealth,
  processNameOf,
  removeStaleLock,
  selfhostEnv,
  staleLockHint,
  superviseChild,
} from "../scripts/selfhost-lib.mjs";

const SERVICE = "watchbell.service";
const TASK = "Watchbell";
const UNIT_MARKER = "# Written by the watchbell CLI";
const LAUNCHD_LABEL = "watchbell";
const READY_TIMEOUT_MS = 120_000;

// [usage, description]: --help prints them all (a test checks that every command is listed).
export const COMMANDS = [
  ["watchbell [start] [--no-open]", "Start Watchbell (the default). First run creates ~/.watchbell, prints the setup code and opens /setup."],
  ["watchbell start --new-key", "Start with a new OPS_ENCRYPTION_KEY when it was lost (tokens saved with the old key can't be read)."],
  ["watchbell run", "Start in the foreground for a service manager (never opens a browser)."],
  ["watchbell stop [--timeout <seconds>]", "Ask the running Watchbell to stop cleanly (default wait 30 s)."],
  ["watchbell status", "Show whether Watchbell runs, its address and folders (exit 0 running, 3 not running)."],
  ["watchbell service install [--yes]", "Start Watchbell when you log in: a systemd user service (Linux) or a Scheduled Task (Windows)."],
  ["watchbell service uninstall [--yes]", "Remove that service or task. Your settings and data stay."],
  ["watchbell reset-login <email>", "Give an account a new temporary password and remove its authenticator (Watchbell stopped)."],
  ["watchbell --version", "Print the version."],
  ["watchbell --help", "Print this help."],
];

export function helpText(version) {
  const width = Math.max(...COMMANDS.map(([u]) => u.length));
  return [
    `Watchbell ${version}: self-hosted ops console`,
    "",
    "Usage:",
    ...COMMANDS.map(([u, d]) => `  ${u.padEnd(width)}  ${d}`),
    "",
    "Settings are in ~/.watchbell/.env (HOST, PORT, SITE_URL, the secrets, providers) and the database in",
    "~/.watchbell/data. Set WATCHBELL_HOME to keep both somewhere else. HOST, PORT and SITE_URL come from the file",
    "(a HOST or PORT your shell exports is ignored); WATCHBELL_HOST, WATCHBELL_PORT and WATCHBELL_SITE_URL in the",
    "environment override them. Other variables set in the environment win over the file, except DATABASE_URL, which",
    "is read from the file only.",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------- arguments

const COMMAND_NAMES = ["start", "run", "stop", "status", "service", "reset-login"];
const OPTION_OWNER = { "--no-open": "start", "--new-key": "start", "--timeout": "stop", "--yes": "service" };

export function parseArgs(argv) {
  const opts = { command: null, args: [], open: true, newKey: false, yes: false, timeout: null, help: false, version: false };
  const errors = [];
  const used = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--version" || a === "-v") opts.version = true;
    else if (a === "--no-open") {
      opts.open = false;
      used.push("--no-open");
    } else if (a === "--new-key") {
      opts.newKey = true;
      used.push("--new-key");
    } else if (a === "--yes" || a === "-y") {
      opts.yes = true;
      used.push("--yes");
    } else if (a === "--timeout") {
      const v = argv[i + 1];
      if (v !== undefined && /^\d{1,4}$/.test(v) && Number(v) > 0) {
        opts.timeout = Number(v);
        i++;
      } else errors.push("--timeout needs a number of seconds (1-9999)");
      used.push("--timeout");
    } else if (a.startsWith("-")) errors.push(`unknown option ${a}`);
    else if (opts.command === null) opts.command = a;
    else opts.args.push(a);
  }
  opts.command ??= "start";
  if (!COMMAND_NAMES.includes(opts.command)) errors.push(`unknown command ${opts.command}`);
  for (const o of used) {
    const owner = OPTION_OWNER[o];
    if (opts.command !== owner) errors.push(`${o} only goes with watchbell ${owner}`);
  }
  if (opts.command === "service") {
    if (opts.args.length !== 1 || !["install", "uninstall"].includes(opts.args[0])) errors.push("use watchbell service install or watchbell service uninstall");
  } else if (opts.command === "reset-login") {
    if (opts.args.length !== 1 || !opts.args[0].trim()) errors.push("use watchbell reset-login <email>");
  } else if (opts.args.length) errors.push(`unexpected argument ${opts.args[0]}`);
  return { opts, errors };
}

// ---------------------------------------------------------------------------------------------------- defaults

async function askOnTty(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/**
 * How to open `url` in the browser, or null for a URL that is not plain. Windows: System32's cmd.exe by full path (a
 * bare "cmd.exe" is looked up in the current folder first, so a planted cmd.exe would run); % and ! are refused because
 * cmd expands them even inside quotes. macOS: /usr/bin/open.
 */
export function browserCommand(url, platform, env = {}) {
  if (!/^https?:\/\/[^\s"'`<>^&|%!]+$/.test(url)) return null; // only plain URLs reach a shell
  if (platform === "win32") {
    const cmd = path.win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "cmd.exe");
    return { cmd, args: ["/d", "/s", "/c", `"start "" "${url}""`], opts: { windowsVerbatimArguments: true, stdio: "ignore", detached: true, windowsHide: true } };
  }
  return { cmd: platform === "darwin" ? "/usr/bin/open" : "xdg-open", args: [url], opts: { stdio: "ignore", detached: true } };
}

function openInBrowser(url, platform, env) {
  const how = browserCommand(url, platform, env);
  if (!how) return;
  try {
    const child = spawn(how.cmd, how.args, how.opts);
    child.on("error", () => {});
    child.unref();
  } catch {
    // no browser here: the URL is printed anyway
  }
}

function runSyncDefault(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, ...opts });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error ?? null };
}

export function defaultDeps() {
  return {
    env: process.env,
    platform: process.platform,
    homedir: os.homedir(),
    execPath: process.execPath,
    nodeVersion: process.versions.node,
    pkgRoot: fileURLToPath(new URL("..", import.meta.url)),
    cliPath: fileURLToPath(import.meta.url),
    out: (m) => console.log(m),
    err: (m) => console.error(m),
    spawn,
    runSync: runSyncDefault,
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    ask: askOnTty,
    openUrl: (url) => openInBrowser(url, process.platform, process.env),
    proc: process,
    kill: (pid, sig) => process.kill(pid, sig),
    processName: (pid) => processNameOf(pid),
    readyTimeoutMs: READY_TIMEOUT_MS,
  };
}

function packageVersion(pkgRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------------------------------- settings

function readEnvFile(file) {
  try {
    return util.parseEnv(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e?.code === "ENOENT") return {};
    throw e;
  }
}

const isSet = (v) => typeof v === "string" && v.trim() !== "";

/** Folders, address and the server's environment, from WATCHBELL_HOME, ~/.watchbell/.env and the environment. */
// "~/wb" quoted in a dotfile reaches us unexpanded; without this it would be a folder named "~" in the current one.
const expandTilde = (p, homedir) => (/^~(?=$|[\\/])/.test(p) ? path.join(homedir, p.slice(1)) : p);

export function resolveContext(d) {
  const home = isSet(d.env.WATCHBELL_HOME) ? path.resolve(expandTilde(d.env.WATCHBELL_HOME.trim(), d.homedir)) : path.join(d.homedir, ".watchbell");
  const envFile = path.join(home, ".env");
  const fromFile = readEnvFile(envFile);
  // Like start-selfhost.mjs, a variable already in the environment wins over the file. Not DATABASE_URL: a developer's
  // shell often exports one, and Watchbell would migrate that database. It comes from the file only; unset means the
  // built-in database.
  const merged = { ...fromFile, ...d.env, DATABASE_URL: fromFile.DATABASE_URL ?? "" };
  // A relative WATCHBELL_DATA_DIR is resolved from WATCHBELL_HOME (the server's own cwd is inside the package).
  const dataSetting = isSet(merged.WATCHBELL_DATA_DIR) ? merged.WATCHBELL_DATA_DIR : isSet(merged.WATCHPOST_DATA_DIR) ? merged.WATCHPOST_DATA_DIR : "data";
  const dataDir = path.resolve(home, dataSetting.trim());
  // Nor the address: tcsh exports HOST=<machine name> (which would bind to the LAN) and many developer shells export
  // PORT. HOST, PORT and SITE_URL come from the file; only WATCHBELL_HOST / WATCHBELL_PORT / WATCHBELL_SITE_URL override.
  const address = (key) => {
    const own = d.env[`WATCHBELL_${key}`];
    if (isSet(own)) return own.trim();
    return isSet(fromFile[key]) ? fromFile[key].trim() : null;
  };
  const host = address("HOST") ?? "127.0.0.1";
  const port = address("PORT") ?? "3100";
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error(`PORT ${port} is not a port number (1-65535)`);
  // SITE_URL as the CLI writes it (http://localhost:<the file's PORT>) follows WATCHBELL_PORT, so the address printed
  // and opened is where the server listens. A SITE_URL of the user's own (a proxy, a name) is kept as it is.
  const filePort = isSet(fromFile.PORT) ? fromFile.PORT.trim() : "3100";
  let siteUrl = address("SITE_URL")?.replace(/\/+$/, "") ?? null;
  if (siteUrl === null || (!isSet(d.env.WATCHBELL_SITE_URL) && siteUrl === `http://localhost:${filePort}`)) siteUrl = `http://localhost:${port}`;
  const serverDir = path.join(d.pkgRoot, "server");
  return { home, envFile, merged, dataDir, host, port, siteUrl, serverDir, lockFile: lockFileOf(dataDir), healthUrl: healthUrlOf(host, port) };
}

/** The environment of the server (and of reset-login): absolute folders, since server.js changes into its own dir. */
export function serverEnv(ctx) {
  return {
    ...selfhostEnv({ ...ctx.merged, WATCHBELL_DATA_DIR: ctx.dataDir }),
    WATCHBELL_HOME: ctx.home,
    WATCHBELL_MIGRATIONS_DIR: path.join(ctx.serverDir, "drizzle-selfhost"),
    HOST: ctx.host,
    HOSTNAME: ctx.host, // what Next's standalone server.js reads
    PORT: ctx.port,
    SITE_URL: ctx.siteUrl,
  };
}

// Same keys and secret sizes as the installers (install.sh / install.ps1 write app/.env the same way), plus a
// per-install key for Next's Server Functions: the prebuilt server carries the build's key, shared by every install.
function wantedSettings(port) {
  return [
    ["WATCHBELL_MODE", () => "selfhost"],
    ["DATABASE_URL", () => "pglite:"],
    ["WATCHBELL_DATA_DIR", () => "./data"],
    ["HOST", () => "127.0.0.1"],
    ["PORT", () => port],
    ["SITE_URL", () => `http://localhost:${port}`],
    ["OPS_ENCRYPTION_KEY", () => randomBytes(32).toString("base64")], // 32 bytes, base64 (src/lib/env.ts)
    ["COLLECTOR_SECRET", () => randomBytes(32).toString("base64url")], // >= 32 chars
    ["CRON_SECRET", () => randomBytes(24).toString("base64url")], // >= 16 chars
    ["NEXT_SERVER_ACTIONS_ENCRYPTION_KEY", () => randomBytes(32).toString("base64")],
  ];
}

const ENV_HEADER = [
  "# Watchbell settings, written by the watchbell CLI. Relative paths are resolved from this folder.",
  "# Never change or lose OPS_ENCRYPTION_KEY: it encrypts the tokens you save, without it they cannot be read.",
];

class HomeError extends Error {}

/**
 * Creates <home>, <home>/data and <home>/.env on first run. Later runs only fill keys that are missing or empty; a
 * value that is set is never changed (an old WATCHPOST_<KEY> counts for WATCHBELL_<KEY>). Returns what it did.
 * A missing OPS_ENCRYPTION_KEY next to an existing database is refused unless `newKey`: a fresh key would make every
 * token saved in it unreadable without a word.
 */
export function ensureHome(ctx, d, { newKey = false } = {}) {
  let sid;
  const userSid = () => (sid ??= windowsSid(d));
  if (!fs.existsSync(ctx.home)) {
    fs.mkdirSync(ctx.home, { recursive: true, mode: 0o700 });
    // Windows: a folder on another drive inherits "Authenticated Users: Modify" from its root. The CLI made this one,
    // so limit it (and so data/ inside it) to this user, like install.ps1 does for .env.
    if (d.platform === "win32") restrictToUser(ctx.home, d, userSid(), "(OI)(CI)F");
  }
  // The database (sessions, audit data, encrypted tokens) is for this user only, whatever the home folder allows.
  fs.mkdirSync(ctx.dataDir, { recursive: true, mode: 0o700 });
  if (d.platform !== "win32") {
    try {
      fs.chmodSync(ctx.dataDir, 0o700);
    } catch {
      d.err(`warning: could not limit ${ctx.dataDir} to your user; keep that folder private.`);
    }
  }
  const exists = fs.existsSync(ctx.envFile);
  const text = exists ? fs.readFileSync(ctx.envFile, "utf8") : "";
  const current = exists ? util.parseEnv(text) : {};
  if (!isSet(current.OPS_ENCRYPTION_KEY) && !newKey && fs.existsSync(path.join(ctx.dataDir, "pg"))) {
    throw new HomeError(
      [
        `OPS_ENCRYPTION_KEY is missing from ${ctx.envFile}, but ${ctx.dataDir} already holds a Watchbell database.`,
        "The tokens saved in it can only be read with the key they were saved with: put that line back from your backup of .env.",
        "To go on with a new key instead (saved tokens must then be entered again), run once: watchbell start --new-key",
      ].join("\n"),
    );
  }
  const port = /^\d{1,5}$/.test(current.PORT?.trim() ?? "") ? current.PORT.trim() : "3100";
  const fill = new Map();
  for (const [key, make] of wantedSettings(port)) {
    if (isSet(current[key])) continue;
    if (key.startsWith("WATCHBELL_") && isSet(current[`WATCHPOST_${key.slice("WATCHBELL_".length)}`])) continue;
    fill.set(key, make());
  }
  if (!exists) {
    const nl = d.platform === "win32" ? "\r\n" : "\n";
    const lines = [...ENV_HEADER, ...[...fill].map(([k, v]) => `${k}=${v}`)];
    fs.writeFileSync(ctx.envFile, lines.join(nl) + nl, { mode: 0o600, flag: "wx" });
    protectEnvFile(ctx.envFile, d, userSid);
    return { created: true, filled: [...fill.keys()] };
  }
  if (fill.size === 0) return { created: false, filled: [] };
  // Present but empty: filled in place. Missing: appended. Every other line stays exactly as it is.
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const src = text.split(/\r?\n/);
  if (src.at(-1) === "") src.pop();
  const done = new Set();
  const out = src.map((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m || !fill.has(m[1])) return line;
    done.add(m[1]);
    return `${m[1]}=${fill.get(m[1])}`;
  });
  for (const [k, v] of fill) if (!done.has(k)) out.push(`${k}=${v}`);
  // Never truncate the real file: a crash mid-write would lose the secrets. Write a protected copy, then swap it in.
  const tmp = `${ctx.envFile}.tmp`;
  const mode = fs.statSync(ctx.envFile).mode & 0o777;
  fs.writeFileSync(tmp, out.join(nl) + nl, { mode: 0o600 });
  if (d.platform === "win32") protectEnvFile(tmp, d, userSid);
  else fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, ctx.envFile);
  if (newKey && fill.has("OPS_ENCRYPTION_KEY")) d.err("warning: a new OPS_ENCRYPTION_KEY was written; tokens saved with the old key can no longer be read. Enter them again.");
  return { created: false, filled: [...fill.keys()] };
}

/** ensureHome, with its failures as one line instead of a stack trace. Null when the home could not be set up. */
function prepareHome(ctx, d, opts) {
  for (let attempt = 0; ; attempt++) {
    try {
      return ensureHome(ctx, d, opts);
    } catch (e) {
      // Two first starts at the same moment: the other one created .env a moment ago, so fill that one instead.
      if (e?.code === "EEXIST" && attempt === 0) continue;
      if (e instanceof HomeError) d.err(e.message);
      else d.err(`watchbell: could not set up ${e?.path ?? ctx.home}: ${e?.code ?? (e instanceof Error ? e.message : String(e))}`);
      return null;
    }
  }
}

const system32Tool = (d, exe) => path.win32.join(d.env.SystemRoot || d.env.SYSTEMROOT || "C:\\Windows", "System32", exe);

// From System32 by full path: a PATH lookup can find another whoami first (Git for Windows ships one).
function windowsSid(d) {
  const who = d.runSync(system32Tool(d, "whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  return /"(S-1-[0-9-]+)"\s*$/.exec(who.stdout.trim())?.[1] ?? null;
}

// Like install.ps1: icacls drops inherited entries and grants `rights` to this user's SID only, no admin rights needed.
function restrictToUser(target, d, sid, rights) {
  const r = sid ? d.runSync(system32Tool(d, "icacls.exe"), [target, "/inheritance:r", "/grant:r", `*${sid}:${rights}`]) : null;
  if (!r || r.status !== 0) d.err(`warning: icacls could not limit ${target} to your user; it keeps the permissions of its folder.`);
}

// The file holds OPS_ENCRYPTION_KEY: owner-only. POSIX: mode 0600. Windows: read, write and delete for this user only.
// Failures only warn.
function protectEnvFile(file, d, userSid) {
  if (d.platform !== "win32") {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      d.err(`warning: could not limit ${file} to your user; keep that folder private.`);
    }
    return;
  }
  restrictToUser(file, d, userSid(), "(R,W,D)");
}

function readSetupCode(dataDir) {
  try {
    const code = fs.readFileSync(path.join(dataDir, "setup-code"), "utf8").trim();
    return code || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------- start / run

const lockOpts = (d) => ({ kill: d.kill, processName: d.processName, execPath: d.execPath });

/** The pid of the Watchbell that holds the database, else null (a lock left by a crash is not a Watchbell). */
const runningPid = (ctx, d) => {
  const lock = inspectLock(ctx.lockFile, lockOpts(d));
  return lock.state === "held" ? lock.pid : null;
};

/** A SITE_URL on this machine with another port than the server's: links and the printed address would be wrong. */
function warnPortMismatch(ctx, d) {
  let url;
  try {
    url = new URL(ctx.siteUrl);
  } catch {
    return;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const urlPort = url.port || (url.protocol === "https:" ? "443" : "80");
  if (local && urlPort !== ctx.port) d.err(`warning: SITE_URL (${ctx.siteUrl}) names port ${urlPort}, but Watchbell listens on port ${ctx.port}. Change one of them in ${ctx.envFile}.`);
}

/** A generic HOST or PORT in the shell that differs from what Watchbell uses: say it is ignored and what overrides. */
function noteIgnoredShellAddress(ctx, d) {
  for (const [key, used] of [["HOST", ctx.host], ["PORT", ctx.port]]) {
    const shell = d.env[key];
    if (!isSet(shell) || shell.trim() === used) continue;
    const from = isSet(d.env[`WATCHBELL_${key}`]) ? `WATCHBELL_${key}` : ctx.envFile;
    d.err(`note: ${key}=${shell.trim()} from your shell is ignored: Watchbell uses ${key}=${used} from ${from}. Set WATCHBELL_${key} to override it.`);
  }
}

async function cmdStart(first, d, { open, foreground, newKey }) {
  let ctx = first;
  const serverJs = path.join(ctx.serverDir, "server.js");
  if (!fs.existsSync(serverJs)) {
    d.err(`This copy of Watchbell has no built server (${serverJs}). Install the package (npm install -g watchbell), or in a source checkout run npm run start:selfhost in app/.`);
    return 1;
  }
  const lock = inspectLock(ctx.lockFile, lockOpts(d));
  if (lock.state === "stale") {
    // A crash or power cut left the lock, and its pid now belongs to another program: the server would refuse to
    // start (and a service would restart it in a loop), so it goes.
    if (removeStaleLock(ctx.lockFile, lock.pid)) d.out(`Removed a leftover database lock (${ctx.lockFile}): process ${lock.pid} is now ${lock.name}, not Watchbell.`);
  } else if (lock.state === "held") {
    const probe = await probeHealth(ctx.healthUrl, d.fetch);
    if (probe?.service === "watchbell") {
      d.err(`Watchbell is already running (process ${lock.pid}, data in ${ctx.dataDir}) at ${ctx.siteUrl}`);
      d.err('Stop it first with "watchbell stop" if you want to start it again.');
    } else {
      d.err(`The database in ${ctx.dataDir} is locked by process ${lock.pid}${lock.name ? ` (${lock.name})` : ""}, but no Watchbell answers at ${ctx.healthUrl}.`);
      d.err('If Watchbell is still starting, wait a moment. If it runs with other settings, stop it with "watchbell stop".');
      d.err(staleLockHint(ctx.lockFile));
    }
    return 1;
  }
  const busy = await probeHealth(ctx.healthUrl, d.fetch);
  if (busy) {
    d.err(
      busy.service === "watchbell"
        ? `Another Watchbell (with other data) already answers on port ${ctx.port}. Stop it, or set another PORT and SITE_URL in ${ctx.envFile}.`
        : `Port ${ctx.port} is already in use by another program. Set another PORT and SITE_URL in ${ctx.envFile}.`,
    );
    return 1;
  }
  const made = prepareHome(ctx, d, { newKey });
  if (!made) return 1;
  if (made.created || made.filled.length) ctx = resolveContext(d); // the server needs what was just written
  const version = packageVersion(d.pkgRoot);
  d.out(`Watchbell ${version}`);
  if (made.created) d.out(`Created ${ctx.envFile} with new secrets (they are not shown).`);
  else if (made.filled.length) d.out(`Added missing settings to ${ctx.envFile}: ${made.filled.join(", ")}.`);
  d.out(`  Settings: ${ctx.envFile}`);
  d.out(`  Data:     ${ctx.dataDir}`);
  warnPortMismatch(ctx, d);
  noteIgnoredShellAddress(ctx, d);
  d.out(`Starting on ${ctx.siteUrl} ...`);

  const child = d.spawn(d.execPath, [serverJs], { cwd: ctx.serverDir, env: serverEnv(ctx), stdio: "inherit" });
  const unsupervise = superviseChild(child, { platform: d.platform, proc: d.proc });
  let exited = false;
  const exit = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve(exitCodeOf(code, signal)));
    child.on("error", (e) => {
      d.err(`Could not start the server: ${e.message}`);
      resolve(1);
    });
  }).finally(() => {
    exited = true;
  });

  const deadline = d.now() + d.readyTimeoutMs;
  while (!exited) {
    const probe = await probeHealth(ctx.healthUrl, d.fetch);
    if (probe?.status === 200) {
      announce(ctx, d, { open, foreground });
      break;
    }
    if (d.now() >= deadline) {
      d.err(`Watchbell did not answer at ${ctx.healthUrl} within ${Math.round(d.readyTimeoutMs / 1000)} s; see the messages above.`);
      break;
    }
    await Promise.race([d.sleep(500), exit]);
  }
  const code = await exit;
  unsupervise();
  return code;
}

function announce(ctx, d, { open, foreground }) {
  const code = readSetupCode(ctx.dataDir);
  d.out("");
  d.out(`Watchbell is running at ${ctx.siteUrl}`);
  if (code) {
    d.out(`First run: open ${ctx.siteUrl}/setup and enter the setup code ${code}`);
    d.out(`(also saved in ${path.join(ctx.dataDir, "setup-code")}; it is gone once the owner account exists).`);
  }
  if (!foreground) d.out('Stop it with Ctrl+C here, or run "watchbell stop" in another terminal.');
  if (open && !foreground) d.openUrl(code ? `${ctx.siteUrl}/setup` : ctx.siteUrl);
}

// ---------------------------------------------------------------------------------------------------- stop / status

function waitExit(child, d) {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve(exitCodeOf(code, signal)));
    child.on("error", (e) => {
      d.err(`watchbell: ${e.message}`);
      resolve(1);
    });
  });
}

// The stop is scripts/stop-selfhost.mjs (shipped in the package): it writes <data>/stop-request, the server runs its
// normal clean stop, and the script waits until the port and the database lock are free.
function stopServer(ctx, d, timeout) {
  if (!fs.existsSync(ctx.home)) {
    d.out(`Watchbell is not running (there are no settings in ${ctx.home} yet).`);
    return Promise.resolve(0);
  }
  const args = [path.join(d.pkgRoot, "scripts", "stop-selfhost.mjs")];
  if (timeout) args.push("--timeout", String(timeout));
  const env = { ...d.env, WATCHBELL_DATA_DIR: ctx.dataDir, HOST: ctx.host, PORT: ctx.port };
  return waitExit(d.spawn(d.execPath, args, { cwd: d.pkgRoot, env, stdio: "inherit" }), d);
}

async function cmdStatus(ctx, d) {
  const pid = runningPid(ctx, d);
  const probe = await probeHealth(ctx.healthUrl, d.fetch);
  const running = pid !== null || probe?.service === "watchbell";
  if (running) {
    d.out(`Watchbell is running${pid !== null ? ` (process ${pid})` : ""} at ${ctx.siteUrl}`);
    if (probe?.service !== "watchbell") d.out(`  Nothing answers at ${ctx.healthUrl} yet. ${staleLockHint(ctx.lockFile)}`);
  } else if (probe) d.out(`Watchbell is not running; another program answers on port ${ctx.port}.`);
  else d.out("Watchbell is not running.");
  d.out(`  Version:  ${packageVersion(d.pkgRoot)}`);
  d.out(`  Settings: ${ctx.envFile}${fs.existsSync(ctx.envFile) ? "" : " (created on the first start)"}`);
  d.out(`  Data:     ${ctx.dataDir}`);
  return running ? 0 : 3;
}

// ---------------------------------------------------------------------------------------------------- reset-login

async function cmdResetLogin(ctx, d, email) {
  const tool = path.join(d.pkgRoot, "tools", "reset-login.mjs");
  if (!fs.existsSync(tool)) {
    d.err(`This copy of Watchbell has no reset-login tool (${tool}). In a source checkout run npm run reset-login -- <email> in app/.`);
    return 1;
  }
  if (!fs.existsSync(path.join(ctx.dataDir, "pg"))) {
    d.err(`No Watchbell database in ${ctx.dataDir} yet. Start Watchbell once and create the owner account first.`);
    return 1;
  }
  const lock = inspectLock(ctx.lockFile, lockOpts(d));
  if (lock.state === "held") {
    d.err(`Watchbell is running (process ${lock.pid}). Stop it first with "watchbell stop", then run watchbell reset-login again.`);
    d.err(staleLockHint(ctx.lockFile));
    return 1;
  }
  if (lock.state === "stale") removeStaleLock(ctx.lockFile, lock.pid); // else the tool's database open would refuse
  return waitExit(d.spawn(d.execPath, [tool, email], { cwd: ctx.home, env: serverEnv(ctx), stdio: "inherit" }), d);
}

// ---------------------------------------------------------------------------------------------------- service

async function consent(d, yes, question) {
  if (yes) return true;
  const ok = await d.ask(question);
  if (!ok) d.out("Nothing changed. (Without a terminal to ask in, pass --yes to confirm.)");
  return ok;
}

// systemd unit values: % starts a specifier everywhere; quoted ExecStart/Environment words also unescape \ and ", and
// ExecStart expands $ (same rules as install.sh).
const unitPath = (s) => s.replaceAll("%", "%%");
const unitWord = (s, { exec = false } = {}) => {
  let v = s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  if (exec) v = v.replaceAll("$", "$$$$");
  return `"${v}"`;
};

export function systemdUnit(ctx, d) {
  return [
    `${UNIT_MARKER} (npm package watchbell). Remove it with: watchbell service uninstall`,
    "[Unit]",
    "Description=Watchbell self-hosted ops console",
    // Restart=on-failure every 5 s never trips systemd's default limit (5 starts in 10 s), so a start that always
    // fails (port taken, database locked) would loop forever. 5 starts in 2 minutes, then it stays failed.
    "StartLimitIntervalSec=120",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${unitPath(ctx.home)}`,
    `Environment=${unitWord(`WATCHBELL_HOME=${ctx.home}`)}`,
    `ExecStart=${unitWord(d.execPath, { exec: true })} ${unitWord(d.cliPath, { exec: true })} run`,
    "Restart=on-failure",
    "RestartSec=5",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=30",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function unitFileOf(d) {
  const config = isSet(d.env.XDG_CONFIG_HOME) ? d.env.XDG_CONFIG_HOME.trim() : path.join(d.homedir, ".config");
  return path.join(config, "systemd", "user", SERVICE);
}

function systemctl(d, ...args) {
  const r = d.runSync("systemctl", ["--user", ...args]);
  if (r.status !== 0) d.err(`systemctl --user ${args.join(" ")} did not work${r.stderr.trim() ? `: ${r.stderr.trim().split(/\r?\n/)[0]}` : ""}`);
  return r.status === 0;
}

async function linuxInstall(ctx, d, yes) {
  if (/[\r\n]/.test(ctx.home + d.execPath + d.cliPath)) {
    d.err("A path with a line break can't go into a systemd unit.");
    return 1;
  }
  if (d.runSync("systemctl", ["--user", "show-environment"]).status !== 0) {
    d.err("There is no systemd user session here (systemctl --user does not answer). Start Watchbell with: watchbell");
    return 1;
  }
  const unitFile = unitFileOf(d);
  const old = fs.existsSync(unitFile) ? fs.readFileSync(unitFile, "utf8") : null;
  const foreign = old !== null && !old.includes(UNIT_MARKER);
  if (foreign) {
    const wd = /^WorkingDirectory=(.*)$/m.exec(old)?.[1];
    d.out(`${unitFile} already exists and was not written by the watchbell CLI${wd ? ` (it runs Watchbell from ${wd})` : ""}.`);
  }
  const question = foreign
    ? `Replace it with a service for the npm package (settings and data in ${ctx.home})? [y/N] `
    : `Install the systemd user service ${SERVICE}, which starts Watchbell when you log in? [y/N] `;
  if (!(await consent(d, yes, question))) return 1;
  const active = d.runSync("systemctl", ["--user", "is-active", "--quiet", SERVICE]).status === 0;
  if (!active && runningPid(ctx, d) !== null) {
    d.err('Watchbell is running in a terminal now. Stop it first ("watchbell stop"), then run watchbell service install again.');
    return 1;
  }
  if (!prepareHome(ctx, d)) return 1;
  fs.mkdirSync(path.dirname(unitFile), { recursive: true });
  fs.writeFileSync(unitFile, systemdUnit(ctx, d));
  d.out(`Wrote ${unitFile}`);
  if (!systemctl(d, "daemon-reload") || !systemctl(d, "enable", SERVICE) || !systemctl(d, "restart", SERVICE)) return 1;
  d.out("");
  d.out("Watchbell runs as a systemd user service and starts when you log in.");
  d.out(`  Status:  systemctl --user status ${SERVICE}   (or: watchbell status)`);
  d.out(`  Logs:    journalctl --user -u ${SERVICE} -f`);
  d.out(`  Stop:    systemctl --user stop ${SERVICE}`);
  d.out(`  Address: ${ctx.siteUrl}`);
  d.out(`  Node.js: ${d.execPath}. After changing or removing this Node.js (nvm, fnm, volta), run watchbell service install again.`);
  const user = d.env.USER || os.userInfo().username;
  const linger = d.runSync("loginctl", ["show-user", user, "-p", "Linger"]);
  if (linger.stdout.trim() !== "Linger=yes") d.out("To keep it running after you log out and start it at boot, run once: loginctl enable-linger $USER");
  return 0;
}

async function linuxUninstall(ctx, d, yes) {
  const unitFile = unitFileOf(d);
  if (!fs.existsSync(unitFile)) {
    d.out(`No ${SERVICE} is installed (${unitFile} does not exist).`);
    return 0;
  }
  const old = fs.readFileSync(unitFile, "utf8");
  if (!old.includes(UNIT_MARKER)) {
    const wd = /^WorkingDirectory=(.*)$/m.exec(old)?.[1];
    d.err(`${unitFile} was not written by the watchbell CLI${wd ? ` (it runs Watchbell from ${wd})` : ""}. Remove it with that folder's uninstall.sh.`);
    return 1;
  }
  if (!(await consent(d, yes, `Remove the Watchbell service? Your settings and data in ${ctx.home} stay. [y/N] `))) return 1;
  // disable --now stops it with SIGTERM: the server closes its database cleanly.
  systemctl(d, "disable", "--now", SERVICE);
  fs.rmSync(unitFile, { force: true });
  systemctl(d, "daemon-reload");
  d.out(`Removed ${unitFile}. Your settings and data stay in ${ctx.home}.`);
  return 0;
}

function powershell(d, script, vars = {}) {
  return d.runSync(system32Tool(d, "WindowsPowerShell\\v1.0\\powershell.exe"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    env: { ...d.env, ...vars },
  });
}

const PS_QUERY = [
  "$t = Get-ScheduledTask -TaskName $env:WB_TASK -ErrorAction SilentlyContinue",
  "if ($null -eq $t) { '{}' } else {",
  "  $a = @($t.Actions) | Select-Object -First 1",
  "  [pscustomobject]@{ state = [string]$t.State; dir = [string]$a.WorkingDirectory } | ConvertTo-Json -Compress",
  "}",
].join("\n");

// Same task as install.ps1 creates, for the npm package: at logon of this user, Interactive and Limited (no admin),
// restart 3 times a minute apart, no time limit, on battery too, one instance. A headless console runs cmd, which sets
// WATCHBELL_HOME and appends the server's output to <home>\watchbell.log.
const PS_REGISTER = [
  "$ErrorActionPreference = 'Stop'",
  "$u = [Security.Principal.WindowsIdentity]::GetCurrent().Name",
  "$a = New-ScheduledTaskAction -Execute $env:WB_EXECUTE -Argument $env:WB_ARGUMENT -WorkingDirectory $env:WB_WORKDIR",
  "$t = New-ScheduledTaskTrigger -AtLogOn -User $u",
  "$s = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) " +
    "-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -Priority 5",
  "$p = New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited",
  "$task = New-ScheduledTask -Action $a -Trigger $t -Settings $s -Principal $p -Description $env:WB_DESCRIPTION",
  "Register-ScheduledTask -TaskName $env:WB_TASK -InputObject $task -Force | Out-Null",
  "Start-ScheduledTask -TaskName $env:WB_TASK",
].join("\n");

const PS_STOP = "Stop-ScheduledTask -TaskName $env:WB_TASK";
const PS_UNREGISTER = "$ErrorActionPreference = 'Stop'\nUnregister-ScheduledTask -TaskName $env:WB_TASK -Confirm:$false";

export function scheduledTaskAction(ctx, d) {
  const root = d.env.SystemRoot || d.env.SYSTEMROOT || "C:\\Windows";
  const system32 = path.win32.join(root, "System32");
  const log = path.win32.join(ctx.home, "watchbell.log");
  const line = `set "WATCHBELL_HOME=${ctx.home}" && "${d.execPath}" "${d.cliPath}" run >> "${log}" 2>&1`;
  return {
    execute: path.win32.join(system32, "conhost.exe"),
    argument: `--headless "${path.win32.join(system32, "cmd.exe")}" /d /s /c "${line}"`,
    workDir: ctx.home,
    log,
  };
}

function taskInfo(d) {
  const r = powershell(d, PS_QUERY, { WB_TASK: TASK });
  if (r.status !== 0) {
    d.err(`PowerShell could not read the Scheduled Tasks (exit ${r.status}).`);
    return undefined;
  }
  try {
    const info = JSON.parse(r.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "{}");
    return typeof info.state === "string" ? info : null;
  } catch {
    d.err("PowerShell gave an answer about the Scheduled Task that could not be read.");
    return undefined;
  }
}

const sameFolder = (a, b) => path.win32.resolve(a).replace(/\\+$/, "").toLowerCase() === path.win32.resolve(b).replace(/\\+$/, "").toLowerCase();

async function windowsInstall(ctx, d, yes) {
  const def = scheduledTaskAction(ctx, d);
  if (/["%\r\n]/.test(ctx.home + d.execPath + d.cliPath)) {
    d.err('A path with " or % can\'t go into the Scheduled Task command line; set WATCHBELL_HOME to a plainer folder.');
    return 1;
  }
  const info = taskInfo(d);
  if (info === undefined) return 1;
  const foreign = info !== null && !sameFolder(info.dir || "", ctx.home);
  if (foreign) d.out(`A Scheduled Task "${TASK}" already exists and runs Watchbell from ${info.dir || "another folder"}.`);
  const question = foreign
    ? `Replace it with a task for the npm package (settings and data in ${ctx.home})? [y/N] `
    : `Create the Scheduled Task "${TASK}", which starts Watchbell when you sign in (no admin rights needed)? [y/N] `;
  if (!(await consent(d, yes, question))) return 1;
  const running = runningPid(ctx, d) !== null;
  if (running && info?.state !== "Running") {
    d.err('Watchbell is running in a terminal now. Stop it first ("watchbell stop"), then run watchbell service install again.');
    return 1;
  }
  if (running && (await stopServer(ctx, d)) !== 0) {
    d.err("The running task did not stop cleanly; nothing changed.");
    return 1;
  }
  if (!prepareHome(ctx, d)) return 1;
  const r = powershell(d, PS_REGISTER, {
    WB_TASK: TASK,
    WB_EXECUTE: def.execute,
    WB_ARGUMENT: def.argument,
    WB_WORKDIR: def.workDir,
    WB_DESCRIPTION: "Starts Watchbell when you sign in. Created by the watchbell CLI; remove it with: watchbell service uninstall",
  });
  if (r.status !== 0) {
    d.err(`Could not create the Scheduled Task (exit ${r.status})${r.stderr.trim() ? `: ${r.stderr.trim().split(/\r?\n/)[0]}` : ""}`);
    return 1;
  }
  d.out(`Watchbell runs as the Scheduled Task "${TASK}" and starts when you sign in.`);
  d.out(`  Address: ${ctx.siteUrl}`);
  d.out(`  Log:     ${def.log} (it grows; delete it now and then while Watchbell is stopped)`);
  d.out(`  Node.js: ${d.execPath}. After changing or removing this Node.js (nvm, fnm, volta), run watchbell service install again.`);
  d.out("  Stop:    watchbell stop");
  d.out("  Remove:  watchbell service uninstall");
  return 0;
}

async function windowsUninstall(ctx, d, yes) {
  const info = taskInfo(d);
  if (info === undefined) return 1;
  if (info === null) {
    d.out(`No Scheduled Task "${TASK}" is installed.`);
    return 0;
  }
  if (!sameFolder(info.dir || "", ctx.home)) {
    d.err(`The Scheduled Task "${TASK}" runs Watchbell from ${info.dir || "another folder"}, not ${ctx.home}. Remove it with that folder's uninstall.bat.`);
    return 1;
  }
  if (!(await consent(d, yes, `Remove the Scheduled Task "${TASK}"? Your settings and data in ${ctx.home} stay. [y/N] `))) return 1;
  // A clean stop first; Stop-ScheduledTask is a hard kill, used only when the clean stop did not finish in time.
  if (runningPid(ctx, d) !== null && (await stopServer(ctx, d)) !== 0) {
    d.err(`warning: the clean stop did not finish; forcing it with Stop-ScheduledTask ${TASK}.`);
    powershell(d, PS_STOP, { WB_TASK: TASK });
  }
  const r = powershell(d, PS_UNREGISTER, { WB_TASK: TASK });
  if (r.status !== 0) {
    d.err(`Could not remove the Scheduled Task (exit ${r.status}).`);
    return 1;
  }
  d.out(`Removed the Scheduled Task "${TASK}". Your settings and data stay in ${ctx.home}.`);
  return 0;
}

const xml = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function launchdPlist(ctx, d) {
  const log = path.join(ctx.home, "watchbell.log");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    `  <array><string>${xml(d.execPath)}</string><string>${xml(d.cliPath)}</string><string>run</string></array>`,
    "  <key>EnvironmentVariables</key>",
    `  <dict><key>WATCHBELL_HOME</key><string>${xml(ctx.home)}</string></dict>`,
    `  <key>WorkingDirectory</key><string>${xml(ctx.home)}</string>`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
    "</dict>",
    "</plist>",
  ].join("\n");
}

function macService(action, ctx, d) {
  const plist = `~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;
  if (action === "uninstall") {
    d.out("watchbell service changes nothing on macOS. If you set up the launchd agent, remove it with:");
    d.out(`  launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL} && rm ${plist}`);
    return 0;
  }
  d.out(`watchbell service installs nothing on macOS. To start Watchbell at login with launchd, save this as ${plist}:`);
  d.out("");
  d.out(launchdPlist(ctx, d));
  d.out("");
  d.out(`then run: launchctl bootstrap gui/$(id -u) ${plist}`);
  d.out('Stop it cleanly with "watchbell stop" (KeepAlive restarts it only after a crash).');
  return 0;
}

async function cmdService(action, ctx, d, yes) {
  if (d.platform === "linux") return action === "install" ? linuxInstall(ctx, d, yes) : linuxUninstall(ctx, d, yes);
  if (d.platform === "win32") return action === "install" ? windowsInstall(ctx, d, yes) : windowsUninstall(ctx, d, yes);
  if (d.platform === "darwin") return macService(action, ctx, d);
  d.err(`watchbell service is not available on ${d.platform}. Have your service manager run: "${d.execPath}" "${d.cliPath}" run`);
  return 1;
}

// ---------------------------------------------------------------------------------------------------- main

export async function main(argv, overrides = {}) {
  const d = { ...defaultDeps(), ...overrides };
  const { opts, errors } = parseArgs(argv);
  const version = packageVersion(d.pkgRoot);
  if (opts.help) {
    d.out(helpText(version));
    return 0;
  }
  if (opts.version) {
    d.out(version);
    return 0;
  }
  if (errors.length) {
    for (const e of errors) d.err(`watchbell: ${e}`);
    d.err("Run watchbell --help for the commands.");
    return 2;
  }
  const major = Number.parseInt(String(d.nodeVersion).split(".")[0], 10);
  if (!(major >= 24)) {
    d.err(`Watchbell needs Node.js 24 or newer; this is Node.js ${d.nodeVersion}.`);
    return 1;
  }
  let ctx;
  try {
    ctx = resolveContext(d);
  } catch (e) {
    d.err(`watchbell: could not read the settings: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  switch (opts.command) {
    case "start":
      return cmdStart(ctx, d, { open: opts.open, foreground: false, newKey: opts.newKey });
    case "run":
      return cmdStart(ctx, d, { open: false, foreground: true, newKey: false });
    case "stop":
      return stopServer(ctx, d, opts.timeout);
    case "status":
      return cmdStatus(ctx, d);
    case "service":
      return cmdService(opts.args[0], ctx, d, opts.yes);
    case "reset-login":
      return cmdResetLogin(ctx, d, opts.args[0].trim());
    default:
      return 2;
  }
}

// Run when started as a program (npm's bin link or shim, or node bin/watchbell.mjs), not when a test imports it.
function startedDirectly() {
  if (typeof import.meta.main === "boolean") return import.meta.main;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (startedDirectly()) process.exitCode = await main(process.argv.slice(2));
