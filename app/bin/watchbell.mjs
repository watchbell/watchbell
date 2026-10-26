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
import readlineCore from "node:readline";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
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
import {
  NODE_CHECK_EVERY_MS,
  NODE_EOL_URL,
  NODE_INDEX_URL,
  nodeVerdict,
  nodeWarningLine,
  parseNodeEol,
  parseNodeIndex,
  storedNodeCycles,
  storedNodeIndex,
} from "../scripts/node-runtime.mjs";
import { LOG_MAX_BYTES, rotateLog } from "../scripts/selfhost-log.mjs";

const SERVICE = "watchbell.service";
const TASK = "Watchbell";
const UNIT_MARKER = "# Written by the watchbell CLI";
const LAUNCHD_LABEL = "watchbell";
const LAUNCHD_THROTTLE_S = 60;
const PLIST_MARKER = "<!-- Written by the watchbell CLI";
const READY_TIMEOUT_MS = 120_000;

// [usage, description]: --help prints them all (a test checks that every command is listed).
export const COMMANDS = [
  ["watchbell [start] [--no-open]", "Start Watchbell (the default). First run creates ~/.watchbell, shows the setup code and opens /setup. In a terminal it shows a short menu: open, keep running in the background, live log, stop."],
  ["watchbell start --verbose", "Show the server's own messages here, as before 1.2.2 (otherwise they go to ~/.watchbell/logs/watchbell.log)."],
  ["watchbell start --new-key", "Start with a new OPS_ENCRYPTION_KEY when it was lost (tokens saved with the old key can't be read)."],
  ["watchbell start --host <addr> --port <n>", "Listen on this address and port for this run (also with run). 0.0.0.0 opens it to your network."],
  ["watchbell run", "Start in the foreground for a service manager (never opens a browser)."],
  ["watchbell stop [--timeout <seconds>]", "Ask the running Watchbell to stop cleanly (default wait 30 s)."],
  ["watchbell status", "Show whether Watchbell runs, the address it really listens on, and its folders (exit 0 running, 3 not running)."],
  ["watchbell service install [--yes]", "Start Watchbell when you log in: a systemd user service (Linux), a Scheduled Task (Windows) or a launchd agent (macOS)."],
  ["watchbell service uninstall [--yes]", "Remove that service or task. Your settings and data stay."],
  ["watchbell update", "Update to the latest version with the npm next to this Node.js, into the folder this copy runs from (an installed service is stopped and started again)."],
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
    "",
    "watchbell start writes the server's messages to ~/.watchbell/logs/watchbell.log (two files of about 5 MB at most);",
    "errors still show in the terminal as one line. watchbell run (for a service manager) prints them as before.",
    "",
    "watchbell start and watchbell status ask registry.npmjs.org at most once a day whether a newer version exists (a",
    "plain GET of the version number, nothing about you), and nodejs.org and endoflife.date at most twice a day whether",
    "this Node.js has a security fix waiting or is past end of life (plain GETs of their public lists; a warning is",
    "printed only then). The running Watchbell reads those two lists every 12 h as well, for its Settings › Collector",
    "page. WATCHBELL_NO_UPDATE_CHECK=1 turns all of it off; NO_UPDATE_NOTIFIER=1 or CI turn off the commands' part.",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------- arguments

const COMMAND_NAMES = ["start", "run", "stop", "status", "service", "reset-login", "update"];
const OPTION_OWNER = { "--no-open": "start", "--new-key": "start", "--verbose": "start", "--timeout": "stop", "--yes": "service", "--host": ["start", "run"], "--port": ["start", "run"] };
/** What an option the CLI doesn't know prints (exit 2): a typo such as --no-openen is never ignored. */
export const unknownOption = (a) => `Unknown option ${a} (see watchbell --help)`;
// An IPv4 or IPv6 address (brackets allowed) or a host name; never something that looks like an option.
const HOST_ARG = /^(?:\[[0-9A-Fa-f:.]+\]|[0-9A-Fa-f.]*:[0-9A-Fa-f:.]*|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;
// Brackets off, IPv6 in lower case, every spelling of the all-zero IPv6 address as "::" (the health check knows that one).
const normalizeHostArg = (v) => {
  const h = v.replace(/^\[(.*)\]$/, "$1");
  if (!h.includes(":")) return h;
  return /^[0:]+$/.test(h) ? "::" : h.toLowerCase();
};
const isPortArg = (v) => /^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;

export function parseArgs(argv) {
  const opts = { command: null, args: [], open: true, newKey: false, verbose: false, yes: false, timeout: null, help: false, version: false, host: null, port: null };
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
    } else if (a === "--verbose") {
      opts.verbose = true;
      used.push("--verbose");
    } else if (a === "--yes" || a === "-y") {
      opts.yes = true;
      used.push("--yes");
    } else if (/^--timeout(=|$)/.test(a)) {
      // --timeout <seconds> or --timeout=<seconds>, like --host and --port.
      const inline = a.length > 9 ? a.slice(10) : undefined;
      const v = inline ?? argv[i + 1];
      if (v !== undefined && /^\d{1,4}$/.test(v) && Number(v) > 0) {
        opts.timeout = Number(v);
        if (inline === undefined) i++;
      } else errors.push("--timeout needs a number of seconds (1-9999)");
      used.push("--timeout");
    } else if (/^--(host|port)(=|$)/.test(a)) {
      // --host <addr> / --port <n>, or --host=<addr> / --port=<n>. A value that is no option is taken even when wrong.
      const name = a.slice(2, 6);
      const inline = a.length > 6 ? a.slice(7) : undefined;
      const v = inline ?? argv[i + 1];
      if (inline === undefined && v !== undefined && !v.startsWith("-")) i++;
      if (name === "host") {
        if (v !== undefined && HOST_ARG.test(v)) opts.host = normalizeHostArg(v);
        else errors.push("--host needs an address, such as 0.0.0.0 or 192.168.1.20");
      } else if (v !== undefined && isPortArg(v)) opts.port = String(Number(v));
      else errors.push("--port needs a port number (1-65535)");
      used.push(`--${name}`);
    } else if (a.startsWith("-")) errors.push(unknownOption(a));
    else if (opts.command === null) opts.command = a;
    else opts.args.push(a);
  }
  opts.command ??= "start";
  if (!COMMAND_NAMES.includes(opts.command)) errors.push(`unknown command ${opts.command}`);
  for (const o of used) {
    const owners = [OPTION_OWNER[o]].flat();
    if (!owners.includes(opts.command)) errors.push(`${o} only goes with ${owners.map((c) => `watchbell ${c}`).join(" or ")}`);
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
    // The menu (1.2.2): raw writes for the cursor codes, and the keyboard. Both ends must be a terminal for it.
    write: (s) => process.stdout.write(s),
    stdin: process.stdin,
    stdoutTty: Boolean(process.stdout.isTTY),
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

const defaultSiteUrl = (host, port) => {
  const h = unbracket(host);
  if (isLoopbackHost(h) || ANY_ADDRESS.has(h)) return `http://localhost:${port}`;
  return h.includes(":") ? `http://[${h}]:${port}` : `http://${h}:${port}`;
};

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
    if (isSet(d.cliAddress?.[key])) return d.cliAddress[key]; // --host / --port, for this run only
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
  // A host that is one address of another network (not this machine, not all of them) answers only there, so the CLI's
  // own SITE_URL names that address: localhost would not answer.
  if (siteUrl === null || (!isSet(d.env.WATCHBELL_SITE_URL) && siteUrl === `http://localhost:${filePort}`)) siteUrl = defaultSiteUrl(host, port);
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
 * This computer's IANA time zone (Europe/Berlin), written as WATCHBELL_TIMEZONE into a NEW .env only: an install
 * from before 1.1 keeps Asia/Jakarta, the app's default. Null when Intl can't name a usable zone (then nothing is
 * written and the default applies). `d.timeZone` replaces Intl in tests. The few old names ICU still prefers are
 * written by their current name (Asia/Calcutta → Asia/Kolkata). Only a full Area/Location name or UTC/GMT is written:
 * an abbreviation (CET, IST) means another zone to Postgres. Both keep in step with lib/time.ts (ZONE_NAME,
 * LEGACY_ZONES; src/lib/time.test.ts compares the copies).
 */
const ZONE_NAME = /^(?:UTC|GMT|[A-Za-z]+(?:\/[A-Za-z0-9_+\-]+)+)$/i;
const LEGACY_ZONES = { "Asia/Calcutta": "Asia/Kolkata", "Asia/Katmandu": "Asia/Kathmandu", "Asia/Saigon": "Asia/Ho_Chi_Minh", "Asia/Rangoon": "Asia/Yangon" };
export function machineTimeZone(d) {
  try {
    const found = (d.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone))();
    const zone = typeof found === "string" ? (LEGACY_ZONES[found] ?? found) : found;
    if (typeof zone !== "string" || !ZONE_NAME.test(zone)) return null;
    new Intl.DateTimeFormat("en-US", { timeZone: zone }); // throws on a name Intl doesn't know
    return zone;
  } catch {
    return null;
  }
}

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
    const zone = machineTimeZone(d);
    const zoneLines = zone ? ["# Times, the daily job (03:00) and the digest (07:00) follow this zone: this computer's when the file was made.", `WATCHBELL_TIMEZONE=${zone}`] : [];
    const lines = [...ENV_HEADER, ...[...fill].map(([k, v]) => `${k}=${v}`), ...zoneLines];
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
    const from = isSet(d.cliAddress?.[key]) ? `--${key.toLowerCase()}` : isSet(d.env[`WATCHBELL_${key}`]) ? `WATCHBELL_${key}` : ctx.envFile;
    d.err(`note: ${key}=${shell.trim()} from your shell is ignored: Watchbell uses ${key}=${used} from ${from}. Set WATCHBELL_${key} to override it.`);
  }
}

async function cmdStart(first, d, { open, foreground, newKey, track, verbose = false }) {
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
    const live = runningContext(ctx, d).ctx; // the address it really runs on (--port), not only the .env one
    const probe = await probeHealth(live.healthUrl, d.fetch);
    if (probe?.service === "watchbell") {
      d.err(`Watchbell is already running (process ${lock.pid}, data in ${ctx.dataDir}) at ${live.siteUrl}`);
      d.err('Stop it first with "watchbell stop" if you want to start it again.');
    } else {
      d.err(`The database in ${ctx.dataDir} is locked by process ${lock.pid}${lock.name ? ` (${lock.name})` : ""}, but no Watchbell answers at ${live.healthUrl}.`);
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
  // 1.2.2: `start` is quiet unless --verbose. `run` (a service manager's log) and --verbose print as before.
  if (!foreground && !verbose) return startQuiet(ctx, d, { open, made, version, serverJs });
  d.out(`Watchbell ${version}`);
  if (made.created) d.out(`Created ${ctx.envFile} with new secrets (they are not shown).`);
  else if (made.filled.length) d.out(`Added missing settings to ${ctx.envFile}: ${made.filled.join(", ")}.`);
  d.out(`  Settings: ${ctx.envFile}`);
  d.out(`  Data:     ${ctx.dataDir}`);
  warnPortMismatch(ctx, d);
  noteIgnoredShellAddress(ctx, d);
  d.out(`Starting on ${ctx.siteUrl} ...`);
  // Asked while the server starts, so it never delays the start; said once the server is ready (start only, not run).
  const update = foreground ? null : checkForUpdate(ctx, d, { background: true });
  const runtime = foreground ? null : checkNodeRuntime(ctx, d, { background: true }); // D20, the same way

  if (track) track.spawned = true;
  const child = d.spawn(d.execPath, [serverJs], { cwd: ctx.serverDir, env: serverEnv(ctx), stdio: "inherit" });
  writeRuntime(ctx, child.pid, d);
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
      announceNetwork(ctx, d);
      await sayUpdate(update, d);
      await sayNodeRuntime(runtime, d);
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
  removeRuntime(ctx, child.pid);
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

// ---------------------------------------------------------------------------------------------------- runtime file

// <data>/runtime.json: the pid and the address of the server the CLI started (start, run), so status and stop find a
// server started with --port or WATCHBELL_PORT even when .env names another port. It counts only while its pid holds
// the database lock: a file left by a crash names a pid that no longer does.
const RUNTIME_FILE = "runtime.json";
const runtimeFileOf = (ctx) => path.join(ctx.dataDir, RUNTIME_FILE);

function writeRuntime(ctx, pid, d) {
  if (!Number.isInteger(pid)) return;
  try {
    fs.writeFileSync(runtimeFileOf(ctx), `${JSON.stringify({ pid, host: ctx.host, port: ctx.port, siteUrl: ctx.siteUrl, startedAt: new Date(d.now()).toISOString() })}\n`, { mode: 0o600 });
  } catch {
    // a read-only data folder: status falls back to the .env address
  }
}

function readRuntime(ctx) {
  try {
    const r = JSON.parse(fs.readFileSync(runtimeFileOf(ctx), "utf8"));
    const ok = Number.isInteger(r?.pid) && typeof r.host === "string" && HOST_ARG.test(r.host) && isPortArg(String(r.port)) && /^https?:\/\/\S+$/.test(String(r.siteUrl));
    return ok ? { pid: r.pid, host: r.host, port: String(r.port), siteUrl: String(r.siteUrl) } : null;
  } catch {
    return null;
  }
}

function removeRuntime(ctx, pid) {
  if (readRuntime(ctx)?.pid !== pid) return; // another start wrote it since
  try {
    fs.rmSync(runtimeFileOf(ctx), { force: true });
  } catch {
    // left behind: it no longer matches the lock, so it is ignored
  }
}

/** { ctx, pid }: ctx with the address of the Watchbell that holds the database now, when the CLI started it. */
function runningContext(ctx, d) {
  const lock = inspectLock(ctx.lockFile, lockOpts(d));
  if (lock.state !== "held") return { ctx, pid: null };
  const rt = readRuntime(ctx);
  if (!rt || rt.pid !== lock.pid) return { ctx, pid: lock.pid };
  return { ctx: { ...ctx, host: rt.host, port: rt.port, siteUrl: rt.siteUrl, healthUrl: healthUrlOf(rt.host, rt.port) }, pid: lock.pid };
}

// ---------------------------------------------------------------------------------------------------- quiet start (1.2.2)

const LOG_DIR = "logs";
/** <home>/logs/watchbell.log: what the server prints under `watchbell start` (watchbell.log.1 holds the older part). */
export const logFileOf = (home) => path.join(home, LOG_DIR, "watchbell.log");
const STOP_WAIT_MS = 30_000;
const ERROR_REPEAT_MS = 10 * 60 * 1000; // the same error line is shown again after 10 minutes at the earliest

/** Every terminal control character out (a log or error line can hold text from a monitored site). */
const plain = (s) => String(s).replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)?|[\x00-\x08\x0b-\x1f\x7f\x9b]/g, "");

/** A terminal the menu can use: both ends a TTY, raw mode available, not CI and not TERM=dumb. */
const interactive = (d) => Boolean(d.stdin?.isTTY && d.stdoutTty && typeof d.stdin.setRawMode === "function") && d.env.TERM !== "dumb" && !switchedOn(d.env.CI);

/** The addresses to show: this machine's for a loopback host, else the network addresses (SITE_URL first when it is its own). */
export function shownAddresses(ctx, interfaces) {
  if (isLoopbackHost(ctx.host)) return [ctx.siteUrl];
  let urls = [];
  try {
    urls = networkUrls(ctx.host, ctx.port, interfaces());
  } catch {
    // no list of addresses
  }
  let site = null;
  try {
    site = new URL(ctx.siteUrl);
  } catch {
    // an unreadable SITE_URL is the server's own error
  }
  if (site && !isLoopbackHost(site.hostname)) urls = [ctx.siteUrl, ...urls.filter((u) => u !== ctx.siteUrl)];
  return urls.length ? urls : [ctx.siteUrl];
}
const addressText = (urls) => (urls.length > 1 ? `${urls[0]}   (also ${urls.slice(1).join(", ")})` : urls[0]);
export const NETWORK_WARNING = ["! Open on your network over plain http. Finish setup first,", "  and put HTTPS in front before opening it to the internet."];

export const MENU = ["Open in browser", "Keep running in the background", "Show live log", "Stop and exit"];

function prepareLog(file, d) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (d.platform !== "win32") fs.chmodSync(dir, 0o700); // the log holds the setup code
  rotateLog(file, { maxBytes: d.logMaxBytes ?? LOG_MAX_BYTES });
}

function appendLog(file, lines) {
  try {
    fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(""), { mode: 0o600 });
  } catch {
    // the log is a help, never a reason to fail
  }
}

/** The last non-empty line of the log (for a server that stopped before it was ready), or null. */
function lastLogLine(file) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, 16 * 1024));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      const lines = buf.toString("utf8").split(/\r?\n/).map((l) => plain(l).trim()).filter(Boolean);
      return lines.at(-1)?.slice(0, 300) ?? null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** The last `count` lines of `file` and its size (where following it starts). */
function tailOf(file, count) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, 64 * 1024));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      const lines = buf.toString("utf8").split(/\r?\n/);
      if (lines.at(-1) === "") lines.pop();
      return { lines: lines.slice(-count), offset: size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { lines: [], offset: 0 };
  }
}

/** Calls onLines with what is appended to `file` (a rotation starts it over). Returns the function that stops it. */
function followFile(file, { offset, everyMs, onLines }) {
  let at = offset;
  let partial = "";
  const timer = setInterval(() => {
    try {
      const size = fs.statSync(file).size;
      if (size < at) {
        at = 0; // rotated: the new file from its start
        partial = "";
      }
      if (size === at) return;
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(Math.min(size - at, 1024 * 1024));
        const n = fs.readSync(fd, buf, 0, buf.length, at);
        at += n;
        const parts = (partial + buf.subarray(0, n).toString("utf8")).split(/\r?\n/);
        partial = parts.pop();
        if (parts.length) onLines(parts);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // gone for a moment (rotation): the next tick tries again
    }
  }, everyMs);
  return () => clearInterval(timer);
}

/** Resolves with the promise's value, or null after `ms` (the timer is cleared either way). */
const within = (promise, ms) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    promise.then((v) => {
      clearTimeout(t);
      resolve(v);
    });
  });

/**
 * Lines printed above a block that is redrawn in place (the "Starting" line, the menu). Without a terminal there is
 * no block and no cursor code: lines are printed as they come.
 */
function makeScreen(d) {
  let block = [];
  const erase = () => {
    if (block.length) d.write(`\r\x1b[${block.length}A\x1b[J`);
  };
  const draw = () => {
    if (block.length) d.write(`${block.join("\n")}\n`);
  };
  return {
    print(lines) {
      erase();
      d.write(lines.map((l) => `${l}\n`).join(""));
      draw();
    },
    setBlock(lines) {
      erase();
      block = lines;
      draw();
    },
  };
}

async function startQuiet(ctx, d, { open, made, version, serverJs }) {
  const tty = interactive(d);
  const logFile = logFileOf(ctx.home);
  let showError = (line) => d.err(line); // in a terminal: above the "Starting" line or the menu
  try {
    prepareLog(logFile, d);
  } catch (e) {
    d.err(`watchbell: could not set up ${path.dirname(logFile)}: ${e?.code ?? (e instanceof Error ? e.message : String(e))}`);
    return 1;
  }
  appendLog(logFile, [
    "",
    `--- watchbell start, Watchbell ${version}, ${new Date(d.now()).toISOString()}`,
    ...(made.created ? [`Created ${ctx.envFile} with new secrets (they are not shown).`] : []),
    ...(made.filled.length && !made.created ? [`Added missing settings to ${ctx.envFile}: ${made.filled.join(", ")}.`] : []),
    `Settings: ${ctx.envFile}`,
    `Data: ${ctx.dataDir}`,
    `Starting on ${ctx.siteUrl} (listening on ${ctx.host}, port ${ctx.port})`,
  ]);
  // New secrets are worth one line (first run only); the folders are in the log and in watchbell status.
  if (made.created) d.out(`Created ${ctx.envFile} with new secrets (they are not shown).`);
  else if (made.filled.length) d.out(`Added missing settings to ${ctx.envFile}: ${made.filled.join(", ")}.`);
  warnPortMismatch(ctx, d);
  noteIgnoredShellAddress(ctx, d);
  const screen = tty ? makeScreen(d) : null;
  if (screen) screen.setBlock([`  Starting Watchbell ${version} ...`]);
  else {
    d.out(`Watchbell ${version}`);
    d.out(`Starting on ${ctx.siteUrl} ...`);
  }
  const update = checkForUpdate(ctx, d, { background: true });
  const runtime = checkNodeRuntime(ctx, d, { background: true });

  // The server's output goes to the log file: through scripts/selfhost-log.mjs (rotation, errors to the menu) when
  // the package has it, and the file itself is the server's stdout and stderr for whatever bypasses that.
  const hook = path.join(d.pkgRoot, "scripts", "selfhost-log.mjs");
  const args = fs.existsSync(hook) ? ["--import", pathToFileURL(hook).href, serverJs] : [serverJs];
  let fd;
  try {
    fd = fs.openSync(logFile, "a", 0o600);
  } catch (e) {
    d.err(`watchbell: could not open ${logFile}: ${e?.code ?? String(e)}`);
    return 1;
  }
  let child;
  try {
    // In a terminal the server runs detached from it from the start (its own session on POSIX, no console on
    // Windows), so "Keep running in the background" only has to let go; the menu is a thin front-end.
    child = d.spawn(d.execPath, args, {
      cwd: ctx.serverDir,
      env: { ...serverEnv(ctx), WATCHBELL_LOG_FILE: logFile },
      stdio: ["ignore", fd, fd, "ipc"],
      detached: tty,
      windowsHide: true,
    });
  } finally {
    fs.closeSync(fd);
  }
  writeRuntime(ctx, child.pid, d);

  let exited = false;
  const exit = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve(exitCodeOf(code, signal)));
    child.on("error", (e) => {
      showError(`Could not start the server: ${e.message}`);
      resolve(1);
    });
  }).finally(() => {
    exited = true;
  });

  // An error the server prints: one line on the screen (the same line at most every 10 minutes), the rest in the log.
  const shown = new Map();
  let lastError = null;
  const onMessage = (m) => {
    if (!m || m.watchbell !== "error" || typeof m.line !== "string") return;
    const line = plain(m.line).trim().slice(0, 300);
    if (!line) return;
    lastError = line;
    const now = d.now();
    if (shown.has(line) && now - shown.get(line) < ERROR_REPEAT_MS) return;
    shown.set(line, now);
    showError(`! ${line} (see the log: ${logFile})`);
  };
  child.on("message", onMessage);
  if (screen) showError = (line) => screen.print([`  ${line}`]);

  // Ctrl+C before the menu is up, a closed terminal, a kill: the same clean stop as "Stop and exit" (in a terminal
  // the server is detached, so no signal reaches it). Without a terminal the server is this process's child as before.
  let stopping = null;
  const stop = () =>
    (stopping ??= (async () => {
      try {
        fs.mkdirSync(ctx.dataDir, { recursive: true });
        fs.writeFileSync(path.join(ctx.dataDir, "stop-request"), `${new Date().toISOString()}\n`); // as watchbell stop
      } catch (e) {
        d.err(`watchbell: could not ask Watchbell to stop (${e?.code ?? e}). Run: watchbell stop`);
      }
      const waitMs = d.stopWaitMs ?? STOP_WAIT_MS;
      const first = await within(exit, waitMs);
      if (first !== null) return first;
      if (d.platform !== "win32") {
        child.kill("SIGTERM"); // the server's own clean stop on SIGTERM
        const second = await within(exit, waitMs);
        if (second !== null) return second;
      }
      d.err(`Watchbell did not stop within ${Math.round(waitMs / 1000)} s; it may still be closing its database. Check with: watchbell status`);
      return 1;
    })());
  const signals = tty ? (d.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] : ["SIGINT", "SIGTERM", "SIGHUP"]) : [];
  const onSignal = () => void stop();
  for (const s of signals) d.proc.on(s, onSignal);
  const unsupervise = tty ? () => {} : superviseChild(child, { platform: d.platform, proc: d.proc });
  const release = () => {
    for (const s of signals) d.proc.removeListener(s, onSignal);
    unsupervise();
  };

  const deadline = d.now() + d.readyTimeoutMs;
  while (!exited) {
    const probe = await probeHealth(ctx.healthUrl, d.fetch);
    if (probe?.status === 200) break;
    if (d.now() >= deadline) {
      // Still starting after the wait: the screen and the menu come anyway (stop, or the log to see why).
      const line = `Watchbell did not answer at ${ctx.healthUrl} within ${Math.round(d.readyTimeoutMs / 1000)} s (see the log: ${logFile}).`;
      if (screen) screen.print([`  ${line}`]);
      else d.err(line);
      break;
    }
    await Promise.race([d.sleep(500), exit]);
  }
  if (exited) {
    const code = await exit;
    if (screen) screen.setBlock([]);
    release();
    removeRuntime(ctx, child.pid);
    if (stopping || [0, 130, 143].includes(code)) return code; // stopped while it was starting (Ctrl+C, a signal)
    d.err(`Watchbell could not start: ${lastError ?? lastLogLine(logFile) ?? `exit ${code}`} (see the log: ${logFile})`);
    return code || 1;
  }

  const setupCode = readSetupCode(ctx.dataDir);
  const urls = shownAddresses(ctx, d.networkInterfaces ?? os.networkInterfaces);
  const lan = !isLoopbackHost(ctx.host);
  // The update notice and the Node.js warning come when they come: a slow registry never holds the screen back.
  const notes = (async () => {
    const lines = [];
    await sayUpdate(update, { out: (l) => lines.push(l) });
    await sayNodeRuntime(runtime, { err: (l) => lines.push(l) });
    return lines;
  })();
  // The long network text (the addresses, SSH tunnel, SITE_URL) is kept in the log; the screen gets two lines.
  if (lan) {
    const note = [];
    announceNetwork(ctx, { ...d, out: (l) => note.push(l), err: (l) => note.push(l) });
    appendLog(logFile, note.filter(Boolean));
  }
  const openTarget = () => (readSetupCode(ctx.dataDir) ? `${ctx.siteUrl}/setup` : ctx.siteUrl);
  if (open) d.openUrl(openTarget());

  if (!screen) {
    d.out(`Watchbell is running at ${addressText(urls)}`);
    if (setupCode) d.out(`First run: open ${ctx.siteUrl}/setup and enter the setup code ${setupCode}`);
    if (lan) for (const l of NETWORK_WARNING) d.err(l);
    d.out(`Log: ${logFile}`);
    d.out('Stop it with Ctrl+C here, or run "watchbell stop" in another terminal.');
    void sayUpdate(update, d);
    void sayNodeRuntime(runtime, d);
    const code = await exit;
    release();
    removeRuntime(ctx, child.pid);
    if (![0, 130, 143].includes(code)) d.err(`Watchbell stopped with exit code ${code} (see the log: ${logFile}).`);
    return code;
  }

  screen.setBlock([]);
  screen.print([
    `  Watchbell ${version}`,
    `  ${addressText(urls)}`,
    ...(setupCode ? [`  First run: setup code ${setupCode}`] : []),
    "",
    ...(lan ? [...NETWORK_WARNING.map((l) => `  ${l}`), ""] : []),
  ]);
  return menu(ctx, d, { child, exit, stop, release, screen, logFile, openTarget, notes });
}

/**
 * The start screen's menu: ↑/↓ and Enter, or a first letter (o and k run their item at once; s moves between the two
 * items that start with S, Enter runs it). Resolves with the CLI's exit code.
 */
function menu(ctx, d, { child, exit, stop, release, screen, logFile, openTarget, notes }) {
  const stdin = d.stdin;
  const pointer = d.platform === "win32" && !d.env.WT_SESSION && d.env.TERM_PROGRAM !== "vscode" ? ">" : "❯"; // the old console lacks ❯
  let selected = 0;
  let mode = "menu";
  let stopFollowing = () => {};
  const lines = () => MENU.map((label, i) => (i === selected ? `  ${pointer} \x1b[1m${label}\x1b[22m` : `    ${label}`));
  const redraw = () => screen.setBlock(lines());

  return new Promise((resolve) => {
    let done = false;
    let stopRequested = false;
    const leaveTerminal = () => {
      stopFollowing();
      stdin.removeListener("keypress", onKey);
      try {
        stdin.setRawMode(false);
      } catch {
        // the terminal is gone
      }
      stdin.pause?.();
      screen.setBlock([]);
    };
    const finish = (code) => {
      if (done) return;
      done = true;
      leaveTerminal();
      release();
      resolve(code);
    };

    const stopAndExit = async () => {
      if (done || stopRequested) return;
      stopRequested = true;
      leaveTerminal();
      screen.print(["  Stopping Watchbell ..."]);
      const code = await stop();
      if (code === 0) d.out("  Watchbell stopped.");
      removeRuntime(ctx, child.pid);
      finish(code);
    };

    const background = () => {
      child.removeAllListeners("message");
      try {
        child.disconnect?.(); // the server keeps running; its errors go to the log only from now on
      } catch {
        // already disconnected
      }
      child.unref?.();
      leaveTerminal();
      d.out("Running in the background. Stop it with: watchbell stop");
      finish(0);
    };

    const showLog = () => {
      mode = "log";
      screen.setBlock([]);
      const { lines: last, offset } = tailOf(logFile, 20);
      screen.print(["", `  Live log (${logFile}). Press any key to go back to the menu.`, "", ...last.map(plain)]);
      stopFollowing = followFile(logFile, { offset, everyMs: d.logPollMs ?? 250, onLines: (ls) => screen.print(ls.map(plain)) });
    };

    const choose = (i) => {
      if (i === 0) {
        const url = openTarget();
        d.openUrl(url);
        screen.print([`  Opening ${url} in your browser.`]);
      } else if (i === 1) background();
      else if (i === 2) showLog();
      else void stopAndExit();
    };

    function onKey(str, key = {}) {
      if (done || stopRequested) return;
      if (key.ctrl && key.name === "c") return void stopAndExit();
      if (mode === "log") {
        stopFollowing();
        stopFollowing = () => {};
        mode = "menu";
        screen.print([""]);
        return redraw();
      }
      if (key.name === "up") selected = (selected + MENU.length - 1) % MENU.length;
      else if (key.name === "down") selected = (selected + 1) % MENU.length;
      else if (key.name === "return" || key.name === "enter") return choose(selected);
      else if (typeof str === "string" && /^[a-z]$/i.test(str)) {
        const hits = MENU.map((label, i) => [label, i]).filter(([label]) => label[0].toLowerCase() === str.toLowerCase());
        if (!hits.length) return;
        selected = (hits.find(([, i]) => i > selected) ?? hits[0])[1];
        if (hits.length === 1) {
          redraw();
          return choose(selected);
        }
      } else return;
      redraw();
    }

    // A signal (a closed terminal, a kill) or Ctrl+C before the menu: stop() already runs; wait for it here.
    exit.then((code) => {
      if (done) return;
      if (stopRequested) return;
      // Stopped from elsewhere (watchbell stop in another terminal) or it crashed.
      leaveTerminal();
      d.out(code === 0 ? "  Watchbell stopped." : `  Watchbell stopped with exit code ${code} (see the log: ${logFile}).`);
      removeRuntime(ctx, child.pid);
      finish(code);
    });

    // The update notice and the Node.js warning, above the menu once they are known (never after it closed).
    notes.then((lines) => {
      if (!done && lines.length) screen.print(lines.map((l) => `  ${plain(l)}`));
    });
    (d.keypressEvents ?? readlineCore.emitKeypressEvents)(stdin);
    stdin.setRawMode(true);
    stdin.resume?.();
    stdin.on("keypress", onKey);
    redraw();
  });
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
function stopServer(first, d, timeout) {
  const { ctx } = runningContext(first, d); // asks the address it really runs on (--port), not only the .env one
  if (!fs.existsSync(ctx.home)) {
    d.out(`Watchbell is not running (there are no settings in ${ctx.home} yet).`);
    return Promise.resolve(0);
  }
  const args = [path.join(d.pkgRoot, "scripts", "stop-selfhost.mjs")];
  if (timeout) args.push("--timeout", String(timeout));
  const env = { ...d.env, WATCHBELL_DATA_DIR: ctx.dataDir, HOST: ctx.host, PORT: ctx.port };
  return waitExit(d.spawn(d.execPath, args, { cwd: d.pkgRoot, env, stdio: "inherit" }), d);
}

async function cmdStatus(first, d) {
  // The address of the server that runs now (1.2.2): started with --port 3261 it answers there, whatever .env says.
  const { ctx, pid } = runningContext(first, d);
  const probe = await probeHealth(ctx.healthUrl, d.fetch);
  const running = pid !== null || probe?.service === "watchbell";
  if (running) {
    d.out(`Watchbell is running${pid !== null ? ` (process ${pid})` : ""} at ${ctx.siteUrl}`);
    if (probe?.service !== "watchbell") d.out(`  Nothing answers at ${ctx.healthUrl} yet. ${staleLockHint(ctx.lockFile)}`);
    if (ctx.port !== first.port) d.out(`  Port:     ${ctx.port} (for this run; ${first.envFile} says ${first.port})`);
  } else if (probe) d.out(`Watchbell is not running; another program answers on port ${ctx.port}.`);
  else d.out("Watchbell is not running.");
  d.out(`  Version:  ${packageVersion(d.pkgRoot)}`);
  d.out(`  Settings: ${ctx.envFile}${fs.existsSync(ctx.envFile) ? "" : " (created on the first start)"}`);
  d.out(`  Data:     ${ctx.dataDir}`);
  const log = logFileOf(ctx.home);
  if (fs.existsSync(log)) d.out(`  Log:      ${log}`);
  const serviceNode = warnServiceNode(ctx, d);
  const update = checkForUpdate(ctx, d);
  // Asked at the same time: status waits for the slower of the two. An installed service may run another Node.js than
  // this CLI (fix round 1, M5), so that one is checked too.
  const runtime = checkNodeRuntime(ctx, d, { serviceNode });
  await sayUpdate(update, d);
  await sayNodeRuntime(runtime, d);
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
    `${PLIST_MARKER} (npm package watchbell). Remove it with: watchbell service uninstall -->`,
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    `  <array><string>${xml(d.execPath)}</string><string>${xml(d.cliPath)}</string><string>run</string></array>`,
    "  <key>EnvironmentVariables</key>",
    `  <dict><key>WATCHBELL_HOME</key><string>${xml(ctx.home)}</string><key>WATCHBELL_SERVICE</key><string>launchd</string></dict>`,
    `  <key>WorkingDirectory</key><string>${xml(ctx.home)}</string>`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    // launchd has no start limit like systemd's StartLimitBurst: at most one start a minute, and `run` gives up with a
    // clean exit (never restarted) on a failure that won't clear or after LAUNCHD_MAX_FAILURES (runUnderLaunchd).
    `  <key>ThrottleInterval</key><integer>${LAUNCHD_THROTTLE_S}</integer>`,
    `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
    "</dict>",
    "</plist>",
  ].join("\n");
}

// macOS: a per-user launchd agent in ~/Library/LaunchAgents, loaded into the user's GUI domain (no admin rights).
const LAUNCHCTL = "/bin/launchctl";
const plistFileOf = (d) => path.join(d.homedir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const guiDomain = (d) => `gui/${d.uid ?? process.getuid?.() ?? os.userInfo().uid}`;
/** Whether the agent is loaded, and whether its process runs now (launchctl print: "state = running"). */
function agentState(d) {
  const r = d.runSync(LAUNCHCTL, ["print", `${guiDomain(d)}/${LAUNCHD_LABEL}`]);
  return { loaded: r.status === 0, running: r.status === 0 && /^\s*state = running\s*$/m.test(r.stdout ?? "") };
}
const agentLoaded = (d) => agentState(d).loaded;
const BOOTOUT_POLLS = 120; // x 250 ms: up to 30 s for the server to close its database
const BOOTOUT_IN_PROGRESS = 36; // "Boot-out failed: 36: Operation now in progress"

/**
 * bootout sends SIGTERM and can return (0, or 36 "in progress") while the job still closes its database; a bootstrap
 * right then fails with 5 or 37. Waits until launchctl print says the job is gone.
 */
async function bootoutAndWait(d) {
  const target = `${guiDomain(d)}/${LAUNCHD_LABEL}`;
  const r = d.runSync(LAUNCHCTL, ["bootout", target]);
  if (r.status !== 0 && r.status !== BOOTOUT_IN_PROGRESS) {
    d.err(`launchctl bootout ${target} did not work${r.stderr.trim() ? `: ${r.stderr.trim().split(/\r?\n/)[0]}` : ""}`);
    return false;
  }
  for (let i = 0; i < BOOTOUT_POLLS; i++) {
    if (!agentLoaded(d)) return true;
    await d.sleep(250);
  }
  d.err(`The launchd agent ${LAUNCHD_LABEL} did not stop within 30 s. Wait a moment, then run watchbell service install again.`);
  return false;
}

function launchctl(d, ...args) {
  const r = d.runSync(LAUNCHCTL, args);
  if (r.status !== 0) d.err(`launchctl ${args.join(" ")} did not work${r.stderr.trim() ? `: ${r.stderr.trim().split(/\r?\n/)[0]}` : ""}`);
  return r.status === 0;
}

async function macInstall(ctx, d, yes) {
  const plistFile = plistFileOf(d);
  const old = fs.existsSync(plistFile) ? fs.readFileSync(plistFile, "utf8") : null;
  const foreign = old !== null && !old.includes(PLIST_MARKER);
  if (foreign) d.out(`${plistFile} already exists and was not written by the watchbell CLI.`);
  const question = foreign
    ? `Replace it with an agent for the npm package (settings and data in ${ctx.home})? [y/N] `
    : `Install the launchd agent ${LAUNCHD_LABEL}, which starts Watchbell when you log in? [y/N] `;
  if (!(await consent(d, yes, question))) return 1;
  const { loaded, running } = agentState(d);
  // A Watchbell in a terminal holds the database; an agent started next to it would fail at every start.
  if (!running && runningPid(ctx, d) !== null) {
    d.err('Watchbell is running in a terminal now. Stop it first ("watchbell stop"), then run watchbell service install again.');
    return 1;
  }
  if (!prepareHome(ctx, d)) return 1;
  fs.mkdirSync(path.dirname(plistFile), { recursive: true });
  fs.writeFileSync(plistFile, `${launchdPlist(ctx, d)}\n`);
  d.out(`Wrote ${plistFile}`);
  // A loaded agent keeps its old definition until it is booted out (bootout stops it with SIGTERM: a clean stop).
  if (loaded && !(await bootoutAndWait(d))) return 1;
  if (!launchctl(d, "bootstrap", guiDomain(d), plistFile)) {
    d.err("Run watchbell service install again in a moment; if it keeps failing, log out and in, then try once more.");
    return 1;
  }
  d.out("");
  d.out("Watchbell runs as a launchd agent and starts when you log in.");
  d.out("  Status:  watchbell status");
  d.out(`  Log:     ${path.join(ctx.home, "watchbell.log")} (it grows; delete it now and then while Watchbell is stopped)`);
  d.out("  Stop:    watchbell stop (launchd restarts it only after a crash)");
  d.out("  Remove:  watchbell service uninstall");
  d.out(`  Address: ${ctx.siteUrl}`);
  d.out(`  Node.js: ${d.execPath}. After changing or removing this Node.js (nvm, fnm, volta, Homebrew), run watchbell service install again.`);
  return 0;
}

async function macUninstall(ctx, d, yes) {
  const plistFile = plistFileOf(d);
  if (!fs.existsSync(plistFile)) {
    d.out(`No launchd agent is installed (${plistFile} does not exist).`);
    return 0;
  }
  if (!(await consent(d, yes, `Remove the launchd agent ${LAUNCHD_LABEL}? Your settings and data in ${ctx.home} stay. [y/N] `))) return 1;
  // bootout stops it with SIGTERM: the server closes its database cleanly.
  if (agentLoaded(d) && !(await bootoutAndWait(d))) return 1;
  fs.rmSync(plistFile, { force: true });
  d.out(`Removed ${plistFile}. Your settings and data stay in ${ctx.home}.`);
  return 0;
}

// launchd restarts a job after every failed exit, with no limit (ThrottleInterval only spaces the starts). Under the
// agent, `run` therefore ends with a clean exit 0, which KeepAlive does not restart, when the start can't succeed
// (port taken, database locked, key missing: nothing was started) and after LAUNCHD_MAX_FAILURES failed exits within
// LAUNCHD_WINDOW_MS (systemd: 5 starts in 2 min, the Scheduled Task: 3 restarts). The count is kept in the home folder.
const LAUNCHD_MAX_FAILURES = 5;
const LAUNCHD_WINDOW_MS = 10 * 60 * 1000;
const LAUNCHD_FAILURES = "launchd-failures.json";

const underLaunchd = (d) => d.env.WATCHBELL_SERVICE === "launchd" || (d.platform === "darwin" && d.env.XPC_SERVICE_NAME === LAUNCHD_LABEL);

function recentFailures(file, now) {
  try {
    const list = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(list) ? list.filter((t) => Number.isFinite(t) && t <= now && now - t < LAUNCHD_WINDOW_MS) : [];
  } catch {
    return [];
  }
}

export async function runUnderLaunchd(ctx, d) {
  const track = { spawned: false };
  const code = await cmdStart(ctx, d, { open: false, foreground: true, newKey: false, track });
  const kick = `launchctl kickstart ${guiDomain(d)}/${LAUNCHD_LABEL}`;
  const file = path.join(ctx.home, LAUNCHD_FAILURES);
  if (code === 0) return 0;
  if (!track.spawned) {
    d.err(`watchbell: launchd will not start Watchbell again until you fix the problem above. Then run: ${kick} (or log out and in).`);
    return 0;
  }
  const now = d.now();
  const failures = [...recentFailures(file, now), now];
  if (failures.length >= LAUNCHD_MAX_FAILURES) {
    d.err(`watchbell: the server stopped with an error ${failures.length} times in 10 minutes; launchd will not restart it again. See the messages above, then run: ${kick}`);
    fs.rmSync(file, { force: true });
    return 0;
  }
  try {
    fs.writeFileSync(file, `${JSON.stringify(failures)}\n`);
  } catch {
    // a read-only home: ThrottleInterval still spaces the restarts
  }
  return code;
}

// ---------------------------------------------------------------------------------------------------- service Node.js

// The Node.js path out of what the CLI wrote: the unit's first ExecStart word, the task's command line, the plist's
// first ProgramArguments string.
const PS_TASK_ACTION = [
  "$t = Get-ScheduledTask -TaskName $env:WB_TASK -ErrorAction SilentlyContinue",
  "if ($null -eq $t) { '{}' } else {",
  "  $a = @($t.Actions) | Select-Object -First 1",
  "  [pscustomobject]@{ dir = [string]$a.WorkingDirectory; args = [string]$a.Arguments } | ConvertTo-Json -Compress",
  "}",
].join("\n");

const unitUnquote = (s) => s.replace(/\\(.)/g, "$1").replaceAll("%%", "%").replaceAll("$$", "$");
const xmlText = (s) => s.replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");

/** The Node.js the installed service of this package runs, or null (no service, someone else's, or unreadable). */
export function serviceNodePath(ctx, d) {
  try {
    if (d.platform === "linux") {
      const unit = fs.readFileSync(unitFileOf(d), "utf8");
      if (!unit.includes(UNIT_MARKER)) return null;
      const m = /^ExecStart="((?:[^"\\]|\\.)*)"/m.exec(unit);
      return m ? unitUnquote(m[1]) : null;
    }
    if (d.platform === "darwin") {
      const plist = fs.readFileSync(plistFileOf(d), "utf8");
      const m = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(plist);
      return m ? xmlText(m[1]) : null;
    }
    if (d.platform === "win32") {
      const r = powershell(d, PS_TASK_ACTION, { WB_TASK: TASK });
      if (r.status !== 0) return null;
      const info = JSON.parse(r.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "{}");
      if (typeof info.args !== "string" || !sameFolder(info.dir || "", ctx.home)) return null;
      return /&& "([^"]+)" "/.exec(info.args)?.[1] ?? null;
    }
  } catch {
    // no service file, or one that can't be read: nothing to say
  }
  return null;
}

/**
 * After a Node.js change (nvm, fnm, volta, an upgrade) the service would fail at every login; say how to fix it.
 * Returns the service's Node.js path when it still exists (status checks that Node.js too, D20), else null.
 */
function warnServiceNode(ctx, d) {
  const node = serviceNodePath(ctx, d);
  if (!node) return null;
  if (fs.existsSync(node)) return node;
  d.err(`The service runs ${node}, which no longer exists. Run: watchbell service install`);
  return null;
}

async function cmdService(action, ctx, d, yes) {
  if (d.platform === "linux") return action === "install" ? linuxInstall(ctx, d, yes) : linuxUninstall(ctx, d, yes);
  if (d.platform === "win32") return action === "install" ? windowsInstall(ctx, d, yes) : windowsUninstall(ctx, d, yes);
  if (d.platform === "darwin") return action === "install" ? macInstall(ctx, d, yes) : macUninstall(ctx, d, yes);
  d.err(`watchbell service is not available on ${d.platform}. Have your service manager run: "${d.execPath}" "${d.cliPath}" run`);
  return 1;
}

// ---------------------------------------------------------------------------------------------------- update notice

// D8: the only request Watchbell's CLI makes on its own. A plain GET of the public version document, no ids or cookies.
const REGISTRY_LATEST = "https://registry.npmjs.org/watchbell/latest";
const UPDATE_CACHE = "update-check.json";
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 3000;
const SEMVER = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/;

/** Like a sort compare (<0, 0, >0); a release is newer than its own pre-releases. Null when either is no version. */
export function compareVersions(a, b) {
  const x = SEMVER.exec(String(a));
  const y = SEMVER.exec(String(b));
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  if (!x[4] || !y[4]) return (x[4] ? -1 : 0) - (y[4] ? -1 : 0);
  const p = x[4].split(".");
  const q = y[4].split(".");
  const num = (s) => /^\d+$/.test(s);
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    if (p[i] === q[i]) continue;
    if (num(p[i]) && num(q[i])) return Number(p[i]) - Number(q[i]);
    if (num(p[i]) || num(q[i])) return num(p[i]) ? -1 : 1;
    return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

const switchedOn = (v) => isSet(v) && !/^(0|false|no|off)$/i.test(v.trim());
/** WATCHBELL_NO_UPDATE_CHECK, NO_UPDATE_NOTIFIER (the usual opt-out of npm tools) or CI turn the check off. */
export const updateCheckOff = (env) => ["WATCHBELL_NO_UPDATE_CHECK", "NO_UPDATE_NOTIFIER", "CI"].some((k) => switchedOn(env[k]));

function readUpdateCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    const at = Date.parse(c?.checkedAt);
    return Number.isFinite(at) && typeof c.latest === "string" && SEMVER.test(c.latest) ? { at, latest: c.latest } : null;
  } catch {
    return null; // none yet, or not ours to trust: ask again
  }
}

/** A plain GET of a public JSON document; null when offline, slower than `timeoutMs`, refused, or not JSON. */
async function getJson(d, url, { background = false, timeoutMs, headers = { accept: "application/json" } }) {
  const ac = new AbortController();
  let timer;
  const late = new Promise((resolve) => {
    timer = (d.setTimer ?? setTimeout)(() => {
      ac.abort();
      resolve(null);
    }, timeoutMs);
    // start does not wait for the answer when the server fails early: the timer must not keep the CLI alive then.
    if (background) timer?.unref?.();
  });
  const ask = (async () => {
    const res = await d.fetch(url, { method: "GET", headers, signal: ac.signal });
    return res?.ok ? await res.json() : null;
  })().catch(() => null);
  try {
    return await Promise.race([ask, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The registry's latest version; null when offline, slower than 3 s, refused, or answered with something else. */
async function registryLatest(d, { background = false } = {}) {
  const v = (await getJson(d, REGISTRY_LATEST, { background, timeoutMs: d.updateTimeoutMs ?? UPDATE_TIMEOUT_MS }))?.version;
  return typeof v === "string" && SEMVER.test(v.trim()) ? v.trim() : null;
}

/**
 * This package's version and the registry's latest: from <home>/update-check.json when it is less than 24 h old, else
 * asked (and the answer saved). A failed ask is saved too, with the last known answer, so an offline machine is not
 * asked on every start. `force` (watchbell update) always asks and returns only the registry's own answer.
 */
async function lookupLatest(ctx, d, { force = false, background = false } = {}) {
  const current = packageVersion(d.pkgRoot);
  const file = path.join(ctx.home, UPDATE_CACHE);
  const cached = readUpdateCache(file);
  const now = d.now();
  if (!force && cached && now >= cached.at && now - cached.at < UPDATE_EVERY_MS) return { current, latest: cached.latest };
  const latest = await registryLatest(d, { background });
  const keep = latest ?? cached?.latest ?? (SEMVER.test(current) ? current : null);
  if (keep && fs.existsSync(ctx.home)) {
    try {
      fs.writeFileSync(file, `${JSON.stringify({ checkedAt: new Date(now).toISOString(), latest: keep })}\n`);
    } catch {
      // a read-only home: the next start asks again
    }
  }
  return { current, latest: force ? latest : (latest ?? cached?.latest ?? null) };
}

/** D8. Never throws; null unless the registry has a newer version than this package. */
export async function checkForUpdate(ctx, d, { background = false } = {}) {
  try {
    // ~/.watchbell/.env as well as the environment (which wins), like every other setting.
    if (updateCheckOff(ctx.merged ?? d.env)) return null;
    const { current, latest } = await lookupLatest(ctx, d, { background });
    return latest && compareVersions(latest, current) > 0 ? { current, latest } : null;
  } catch {
    return null;
  }
}

async function sayUpdate(check, d) {
  const found = check ? await check : null;
  if (found) d.out(`A newer Watchbell is available: ${found.latest} (this is ${found.current}). Update with: watchbell update`);
}

// ---------------------------------------------------------------------------------------------------- Node.js runtime (D20)

// 1.2.2: the Node.js under Watchbell. The server runs on the Node.js that runs this CLI (d.execPath), so its version is
// d.nodeVersion. Two plain GETs at once, nodejs.org's release list and endoflife.date's Node.js lines, at most once per
// 12 h: the answer, or a failed ask, is kept in <home>/node-check.json like the update check's. The verdict is
// scripts/node-runtime.mjs, shared with the console's Settings › Collector line. The update check's switches turn this
// off too (WATCHBELL_NO_UPDATE_CHECK also turns off the server's own 12-hourly reads, src/lib/collector/node-runtime.ts). One warning line for a vulnerable or end-of-life Node.js; offline or an answer it can't read prints nothing,
// and it never holds the start back.
const NODE_CACHE = "node-check.json";
const NODE_TIMEOUT_MS = 4000; // the release list is about 350 kB (about 40 kB gzipped)
// Fix round 1 (M4): gzip only. Node's fetch would offer br, and Node2Shell, the advisory this check exists for, is in
// Node's Brotli decoder: a vulnerable Node.js shouldn't Brotli-decode the very lists that flag it.
const NODE_HEADERS = { accept: "application/json", "accept-encoding": "gzip" };
const SERVICE_VERSION_TIMEOUT_MS = 1000;

function readNodeCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    const at = Date.parse(c?.checkedAt);
    if (!Number.isFinite(at)) return null;
    return { at, index: storedNodeIndex(c.index), indexOk: c.indexOk === true, cycles: storedNodeCycles(c.cycles) };
  } catch {
    return null; // none yet, or not ours to trust: ask again
  }
}

async function lookupNodeAdvisories(ctx, d, { background = false } = {}) {
  const file = path.join(ctx.home, NODE_CACHE);
  const cached = readNodeCache(file);
  const now = d.now();
  if (cached && now >= cached.at && now - cached.at < NODE_CHECK_EVERY_MS) return cached;
  const timeoutMs = d.nodeTimeoutMs ?? NODE_TIMEOUT_MS;
  const [indexBody, eolBody] = await Promise.all([getJson(d, NODE_INDEX_URL, { background, timeoutMs, headers: NODE_HEADERS }), getJson(d, NODE_EOL_URL, { background, timeoutMs, headers: NODE_HEADERS })]);
  const index = parseNodeIndex(indexBody);
  const cycles = parseNodeEol(eolBody);
  // A failed source keeps its last good data; indexOk records whether this ask of nodejs.org worked ("ok" needs it).
  const next = { at: now, index: index ?? cached?.index ?? null, indexOk: index !== null, cycles: cycles ?? cached?.cycles ?? null };
  if (fs.existsSync(ctx.home)) {
    try {
      fs.writeFileSync(file, `${JSON.stringify({ checkedAt: new Date(now).toISOString(), indexOk: next.indexOk, index: next.index, cycles: next.cycles })}\n`);
    } catch {
      // a read-only home: the next start asks again
    }
  }
  return next;
}

/** The version an installed service's Node.js reports ("v24.12.0"), or null when it can't be run within a second. */
function serviceNodeVersion(node, d) {
  const r = d.runSync(node, ["--version"], { timeout: SERVICE_VERSION_TIMEOUT_MS });
  return r.status === 0 ? r.stdout.trim() : null;
}

const samePath = (a, b, platform) => {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/**
 * D20. Never throws; the warning lines (none when this Node.js is fine, unknown or the check is off). `serviceNode`
 * (status only): the installed service's Node.js path; when it isn't this one and runs another version, that version
 * is checked too and named in its own line.
 */
export async function checkNodeRuntime(ctx, d, { background = false, serviceNode = null } = {}) {
  try {
    if (updateCheckOff(ctx.merged ?? d.env)) return [];
    const data = await lookupNodeAdvisories(ctx, d, { background });
    const verdict = (version) => nodeVerdict(String(version), { index: data.index, indexFresh: data.indexOk, cycles: data.cycles }, d.now());
    const own = verdict(d.nodeVersion);
    const lines = [nodeWarningLine(own)];
    if (serviceNode && !samePath(serviceNode, d.execPath, d.platform)) {
      const theirs = verdict(serviceNodeVersion(serviceNode, d) ?? "");
      if (theirs.version !== null && theirs.version !== own.version) lines.push(nodeWarningLine(theirs, { service: serviceNode }));
    }
    return lines.filter(Boolean);
  } catch {
    return [];
  }
}

async function sayNodeRuntime(check, d) {
  for (const line of check ? await check : []) d.err(line);
}

// ---------------------------------------------------------------------------------------------------- network (D10)

const unbracket = (h) => h.replace(/^\[(.*)\]$/, "$1");
export const isLoopbackHost = (host) => {
  const h = unbracket(String(host)).toLowerCase();
  return h === "localhost" || h === "::1" || /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
};
const ANY_ADDRESS = new Set(["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);

/** The http addresses other computers can use: every network address of this machine for 0.0.0.0 / ::, else the host. */
export function networkUrls(host, port, interfaces) {
  const h = unbracket(host);
  const at = (a) => (a.includes(":") ? `http://[${a}]:${port}` : `http://${a}:${port}`);
  if (!ANY_ADDRESS.has(h)) return [at(h)];
  const out = [];
  for (const list of Object.values(interfaces ?? {})) {
    for (const i of list ?? []) {
      if (i.internal) continue;
      if (i.family === "IPv4" || i.family === 4) out.push(at(i.address));
      else if (h !== "0.0.0.0" && !/^fe80:/i.test(i.address)) out.push(at(i.address)); // :: also takes IPv6
    }
  }
  return [...new Set(out)];
}

/** A host other than this machine: where others can open it, what that means, and SITE_URL when it names localhost. */
function announceNetwork(ctx, d) {
  if (isLoopbackHost(ctx.host)) return;
  let urls = [];
  try {
    urls = networkUrls(ctx.host, ctx.port, (d.networkInterfaces ?? os.networkInterfaces)());
  } catch {
    // no list of addresses: the warning still applies
  }
  d.out("");
  d.out(urls.length ? `Watchbell listens on ${ctx.host}, so other computers can open it at:` : `Watchbell listens on ${ctx.host} (no network address of this machine was found).`);
  for (const u of urls) d.out(`  ${u}`);
  d.err("warning: everyone who can reach these addresses gets the Watchbell sign-in page, and plain http sends passwords");
  d.err("readable on the network. Finish /setup (the owner account) before you share the address, and put HTTPS in front");
  d.err("(a reverse proxy) before you open it to the internet. Safer for one person: keep HOST=127.0.0.1 and use an SSH");
  d.err('tunnel (see "Open it from another computer" in the install guide).');
  let site = null;
  try {
    site = new URL(ctx.siteUrl);
  } catch {
    // an unreadable SITE_URL is the server's own error
  }
  if (site && isLoopbackHost(site.hostname)) {
    const example = urls[0] ?? `http://<this computer's address>:${ctx.port}`;
    d.err(
      `note: SITE_URL is ${ctx.siteUrl}, so links in alerts and messages lead to localhost. Signing in from another computer ` +
        `works anyway; for links that work there, set SITE_URL=${example} in ${ctx.envFile} (or WATCHBELL_SITE_URL for one run).`,
    );
  }
}

// ---------------------------------------------------------------------------------------------------- update (D9)

const PS_START = "Start-ScheduledTask -TaskName $env:WB_TASK";

/**
 * 1.2.2: the npm prefix this copy was installed into, from its own folder: <prefix>/lib/node_modules/watchbell on
 * Linux and macOS, <prefix>\node_modules\watchbell on Windows. Null for any other layout (a project's node_modules,
 * pnpm, a source checkout): npm then installs where it always does, and the "still holds" check catches a miss.
 */
export function installPrefix(pkgRoot, platform) {
  const root = path.resolve(pkgRoot);
  const name = (p) => (platform === "win32" ? path.basename(p).toLowerCase() : path.basename(p));
  const modules = path.dirname(root);
  if (name(root) !== "watchbell" || name(modules) !== "node_modules") return null;
  if (platform === "win32") return path.dirname(modules);
  const lib = path.dirname(modules);
  return name(lib) === "lib" ? path.dirname(lib) : null;
}

const npmUpdateArgs = (prefix) => ["install", "-g", ...(prefix ? ["--prefix", prefix] : []), "watchbell@latest"];
/** The update command as a person types it (the prefix quoted when it has a space). */
const npmUpdateText = (prefix) => `npm ${npmUpdateArgs(prefix).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`;

/**
 * The npm next to the running Node.js (npm.cmd on Windows, run through System32's cmd.exe), installing into `prefix`
 * when it is known; null if cmd can't take the paths.
 */
export function npmCommand(d, prefix = null) {
  const p = d.platform === "win32" ? path.win32 : path.posix;
  const npm = p.join(p.dirname(d.execPath), d.platform === "win32" ? "npm.cmd" : "npm");
  const args = npmUpdateArgs(prefix);
  if (d.platform !== "win32") return { npm, cmd: npm, args, opts: {} };
  // cmd expands % even inside quotes, and a quoted path ending in \ would escape its closing quote.
  if (/["%\r\n]/.test(npm + (prefix ?? "")) || prefix?.endsWith("\\")) return null;
  const line = args.map((a) => (a === prefix ? `"${a}"` : a)).join(" ");
  return { npm, cmd: system32Tool(d, "cmd.exe"), args: ["/d", "/s", "/c", `""${npm}" ${line}"`], opts: { windowsVerbatimArguments: true } };
}

const writableDir = (dir) => {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** The service of the npm package that runs now, with how to stop it cleanly and start it again; else null. */
async function runningService(ctx, d) {
  if (d.platform === "linux") {
    let unit = null;
    try {
      unit = fs.readFileSync(unitFileOf(d), "utf8");
    } catch {
      return null;
    }
    if (!unit.includes(UNIT_MARKER)) return null; // an installer's unit runs a source checkout, not this package
    if (d.runSync("systemctl", ["--user", "is-active", "--quiet", SERVICE]).status !== 0) return null;
    return {
      name: `the systemd user service ${SERVICE}`,
      stopHint: `systemctl --user stop ${SERVICE}`,
      startHint: `systemctl --user start ${SERVICE}`,
      stop: async () => systemctl(d, "stop", SERVICE),
      start: async () => systemctl(d, "start", SERVICE),
    };
  }
  if (d.platform === "win32") {
    const info = taskInfo(d);
    if (!info || info.state !== "Running" || !sameFolder(info.dir || "", ctx.home)) return null;
    return {
      name: `the Scheduled Task "${TASK}"`,
      stopHint: "watchbell stop",
      startHint: `Start-ScheduledTask ${TASK}, or sign out and in`,
      stop: async () => (await stopServer(ctx, d)) === 0, // the clean stop; the task ends with the server
      start: async () => {
        const r = powershell(d, PS_START, { WB_TASK: TASK });
        if (r.status !== 0) d.err(`Could not start the Scheduled Task "${TASK}" again (exit ${r.status}). Sign out and in, or run: watchbell`);
        return r.status === 0;
      },
    };
  }
  if (d.platform === "darwin") {
    // Only an agent whose process runs now: after "watchbell stop" it stays loaded but idle, and a Watchbell started in
    // a terminal then is not the service's to restart.
    if (!fs.existsSync(plistFileOf(d)) || !agentState(d).running || runningPid(ctx, d) === null) return null;
    return {
      name: `the launchd agent ${LAUNCHD_LABEL}`,
      stopHint: "watchbell stop",
      startHint: `launchctl kickstart ${guiDomain(d)}/${LAUNCHD_LABEL}`,
      stop: async () => (await stopServer(ctx, d)) === 0, // a clean exit: KeepAlive restarts it only after a crash
      start: async () => launchctl(d, "kickstart", `${guiDomain(d)}/${LAUNCHD_LABEL}`),
    };
  }
  return null;
}

/** What to do by hand: stop Watchbell (its service, when one runs), run `cmd`, start it again. */
function byHand(service, cmd) {
  if (!service) return `Stop Watchbell ("watchbell stop"), then run: ${cmd}`;
  return `Stop ${service.name} (${service.stopHint}), run ${cmd}, then start it again (${service.startHint}).`;
}

function packageName(pkgRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).name ?? null;
  } catch {
    return null;
  }
}

/**
 * D9: `npm install -g watchbell@latest` with the npm next to this Node.js, only while Watchbell is stopped; since 1.2.2
 * with `--prefix` of the folder this copy runs from (installPrefix), so a Node.js elsewhere on PATH (nvm next to a
 * copy in ~/.local) can no longer take the update. A running
 * service of the package is stopped cleanly first and started again after (also when npm failed: the old version
 * then runs on). 0: updated or already the latest; 1: running, npm failed, or the service did not stop.
 */
export async function cmdUpdate({ ctx }, d) {
  // `sudo watchbell update` reads root's home: it would not see the user's Watchbell or stop its service.
  if ((d.uid ?? process.getuid?.()) === 0 && isSet(d.env.SUDO_USER)) {
    d.err(`Run watchbell update as ${d.env.SUDO_USER.trim()}, without sudo: as root it looks at ${ctx.home} and can't see or stop your Watchbell.`);
    d.err("When npm needs root, watchbell update says so and names the sudo command to run.");
    return 1;
  }
  if (packageName(d.pkgRoot) !== "watchbell") {
    d.err(`This Watchbell (${d.pkgRoot}) is not the npm package. Update a source checkout with git, or with its installer's --upgrade.`);
    return 1;
  }
  const { current, latest } = await lookupLatest(ctx, d, { force: true });
  const newer = latest ? compareVersions(latest, current) : null;
  if (newer !== null && newer <= 0) {
    d.out(`Watchbell ${current} is the latest version.`);
    return 0;
  }
  if (latest === null) d.out("Could not ask registry.npmjs.org for the latest version; npm will try.");
  const prefix = installPrefix(d.pkgRoot, d.platform);
  const NPM_UPDATE = npmUpdateText(prefix);
  const npm = npmCommand(d, prefix);
  if (!npm) {
    d.err(`The folder of this Node.js or of Watchbell can't go on a cmd command line. Stop Watchbell and run: ${NPM_UPDATE}`);
    return 1;
  }
  const service = await runningService(ctx, d);
  // A system Node.js (/usr/lib/node_modules) is owned by root: say so before anything is stopped.
  const npmFolder = path.dirname(d.pkgRoot);
  if (d.platform !== "win32" && !writableDir(npmFolder)) {
    d.err(`npm can't write to ${npmFolder} as your user, so watchbell update can't update it.`);
    d.err(byHand(service, `sudo ${NPM_UPDATE}`));
    return 1;
  }
  if (service) {
    d.out(`Stopping ${service.name} for the update ...`);
    if (!(await service.stop())) {
      d.err(`Could not stop ${service.name}; nothing was updated.`);
      return 1;
    }
  } else {
    const pid = runningPid(ctx, d);
    if (pid !== null) {
      d.err(`Watchbell is running (process ${pid}). Stop it first with "watchbell stop", then run watchbell update again.`);
      return 1;
    }
  }
  d.out(`Updating Watchbell ${current}${latest ? ` to ${latest}` : ""}: ${npm.npm} ${NPM_UPDATE.slice(4)}`);
  // POSIX: npm starts with "#!/usr/bin/env node", so this Node.js goes first on PATH, else npm runs (and installs for)
  // whichever node PATH finds first. A large maxBuffer: a verbose .npmrc must not get npm killed mid-install.
  const env = d.platform === "win32" ? d.env : { ...d.env, PATH: [path.posix.dirname(d.execPath), d.env.PATH].filter(isSet).join(":") };
  const r = d.runSync(npm.cmd, npm.args, { ...npm.opts, env, stdio: ["inherit", "inherit", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const said = (r.stderr ?? "").trim();
  if (said) d.err(said); // npm's warnings too, not only its errors
  let code = 0;
  if (r.status !== 0) {
    code = 1;
    d.err(r.error ? `Could not run ${npm.npm}: ${r.error.code ?? r.error.message}.` : `npm could not update Watchbell (exit ${r.status}).`);
    d.err(service ? byHand(service, NPM_UPDATE) : `Run it yourself: ${NPM_UPDATE}`);
    if (d.platform !== "win32" && /\bEACCES\b|\bEPERM\b|permission denied/i.test(said)) {
      d.err(`npm's global folder is not writable by your user. ${byHand(service, `sudo ${NPM_UPDATE}`)}`);
    }
  } else {
    const now = packageVersion(d.pkgRoot);
    if (now === current && newer !== null && newer > 0) {
      code = 1;
      d.err(`npm finished, but ${d.pkgRoot} still holds Watchbell ${now}: the new version went to another folder.`);
      d.err(
        prefix
          ? `npm was told to install into ${prefix}, where this copy runs from. A copy made with npm link, or kept by another tool (volta, pnpm), updates its own way; "npm ls -g --prefix ${/\s/.test(prefix) ? `"${prefix}"` : prefix} watchbell" shows what that folder holds.`
          : `This copy is not in an npm global folder (<prefix>/${d.platform === "win32" ? "" : "lib/"}node_modules/watchbell), so update it the way you installed it. "npm prefix -g" shows where npm installs.`,
      );
    } else d.out(now === current ? `Watchbell ${now} is up to date.` : `Updated Watchbell ${current} to ${now}.`);
  }
  if (service) {
    d.out(`Starting ${service.name} again ...`);
    if (!(await service.start())) code = 1;
  }
  return code;
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
    // An unknown option is its own complete line; every other mistake gets the prefix and the pointer to --help.
    const unknown = (e) => e.startsWith("Unknown option ");
    for (const e of errors) d.err(unknown(e) ? e : `watchbell: ${e}`);
    if (!errors.every(unknown)) d.err("Run watchbell --help for the commands.");
    return 2;
  }
  const major = Number.parseInt(String(d.nodeVersion).split(".")[0], 10);
  if (!(major >= 24)) {
    d.err(`Watchbell needs Node.js 24 or newer; this is Node.js ${d.nodeVersion}.`);
    return 1;
  }
  if (opts.host !== null || opts.port !== null) d.cliAddress = { HOST: opts.host, PORT: opts.port };
  let ctx;
  try {
    ctx = resolveContext(d);
  } catch (e) {
    d.err(`watchbell: could not read the settings: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  switch (opts.command) {
    case "start":
      return cmdStart(ctx, d, { open: opts.open, foreground: false, newKey: opts.newKey, verbose: opts.verbose });
    case "run":
      if (underLaunchd(d)) return runUnderLaunchd(ctx, d);
      return cmdStart(ctx, d, { open: false, foreground: true, newKey: false });
    case "stop":
      return stopServer(ctx, d, opts.timeout);
    case "status":
      return cmdStatus(ctx, d);
    case "service":
      return cmdService(opts.args[0], ctx, d, opts.yes);
    case "reset-login":
      return cmdResetLogin(ctx, d, opts.args[0].trim());
    case "update":
      return cmdUpdate({ ctx }, d);
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
