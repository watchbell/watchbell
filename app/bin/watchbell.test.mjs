// node --test bin/  (npm run test:cli). The watchbell CLI against stubs, plus real runs of the CLI file in a scratch
// package folder with a fake server.js, so start → ready → setup code → stop is exercised end to end without a build.
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { inspectLock, looksLikeServer, processNameOf, superviseChild } from "../scripts/selfhost-lib.mjs";
import { browserCommand, COMMANDS, main, parseArgs, scheduledTaskAction, systemdUnit } from "./watchbell.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
// Scratch space: WATCHBELL_TEST_TMP (or the old WATCHPOST_TEST_TMP), else <repo>/.cache/tmp. Never the OS temp folder.
const BASE = process.env.WATCHBELL_TEST_TMP?.trim() || process.env.WATCHPOST_TEST_TMP?.trim() || path.resolve(APP, "..", ".cache", "tmp");
fs.mkdirSync(BASE, { recursive: true });
const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const scratch = (name) => {
  const d = fs.mkdtempSync(path.join(BASE, `watchbell-cli ${name}-`));
  made.push(d);
  return d;
};

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.signals = [];
  }
  kill(sig) {
    this.signals.push(sig);
    return true;
  }
}

/** A scratch package root (package.json + server/server.js placeholder) and a stub for everything main() touches. */
function harness({ env = {}, platform = "linux", fetch, exitWith = 0, runSync, ask, lockAlive = [], processName = () => "node" } = {}) {
  const root = scratch("box");
  const pkgRoot = path.join(root, "pkg");
  fs.mkdirSync(path.join(pkgRoot, "server"), { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "watchbell", version: "9.9.9" }));
  fs.writeFileSync(path.join(pkgRoot, "server", "server.js"), "// placeholder\n");
  const home = path.join(root, "home dir");
  const log = { out: [], err: [], spawns: [], opened: [], runs: [], asked: [] };
  const proc = new EventEmitter();
  const deps = {
    env: { WATCHBELL_HOME: home, ...env },
    platform,
    homedir: path.join(root, "user"),
    execPath: "/usr/bin/node",
    nodeVersion: "24.11.1",
    pkgRoot,
    cliPath: path.join(pkgRoot, "bin", "watchbell.mjs"),
    out: (m) => log.out.push(m),
    err: (m) => log.err.push(m),
    spawn: (cmd, args, opts) => {
      const child = new FakeChild();
      log.spawns.push({ cmd, args, opts, child });
      if (exitWith !== null) setImmediate(() => child.emit("exit", exitWith, null));
      return child;
    },
    runSync:
      runSync ??
      ((cmd, args, opts) => {
        log.runs.push({ cmd, args, env: opts?.env });
        return { status: 0, stdout: "", stderr: "" };
      }),
    fetch: fetch ?? (async () => Promise.reject(new Error("ECONNREFUSED"))),
    sleep: () => new Promise((r) => setImmediate(r)),
    now: () => 0,
    ask: async (q) => {
      log.asked.push(q);
      return ask ?? false;
    },
    openUrl: (u) => log.opened.push(u),
    proc,
    kill: (pid) => {
      if (!lockAlive.includes(pid)) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    },
    processName,
    readyTimeoutMs: 60_000,
  };
  const run = (argv) => main(argv, deps);
  return { root, pkgRoot, home, envFile: path.join(home, ".env"), dataDir: path.join(home, "data"), deps, log, run, proc };
}

const healthy = async () => new Response(JSON.stringify({ ok: true, service: "watchbell" }), { status: 200 });

// An existing install: settings with its key (a database without OPS_ENCRYPTION_KEY is refused).
function existingSettings(h) {
  fs.mkdirSync(h.home, { recursive: true });
  fs.writeFileSync(h.envFile, `OPS_ENCRYPTION_KEY=${Buffer.alloc(32, 7).toString("base64")}\n`);
}

function holdLock(dataDir, pid) {
  fs.mkdirSync(path.join(dataDir, "pg"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "pg", ".watchpost.lock"), String(pid));
}

describe("arguments and help", () => {
  test("--help lists every command", async () => {
    const h = harness();
    assert.equal(await h.run(["--help"]), 0);
    const help = h.log.out.join("\n");
    for (const c of ["start", "run", "stop", "status", "service install", "service uninstall", "reset-login <email>", "--version", "--help", "--no-open", "--timeout", "--yes"]) {
      assert.ok(help.includes(c), `help lacks ${c}`);
    }
    for (const [usage] of COMMANDS) assert.ok(help.includes(usage), usage);
    assert.ok(help.includes("WATCHBELL_HOME"));
  });

  test("--version prints the package version", async () => {
    const h = harness();
    assert.equal(await h.run(["--version"]), 0);
    assert.deepEqual(h.log.out, ["9.9.9"]);
  });

  test("unknown commands, options and misplaced options exit 2 without touching anything", async () => {
    for (const argv of [["frobnicate"], ["--bogus"], ["stop", "--no-open"], ["service"], ["service", "restart"], ["reset-login"], ["status", "extra"], ["stop", "--timeout", "0"]]) {
      const h = harness();
      assert.equal(await h.run(argv), 2, argv.join(" "));
      assert.ok(h.log.err.some((e) => e.startsWith("watchbell: ")), argv.join(" "));
      assert.equal(fs.existsSync(h.home), false, argv.join(" "));
    }
  });

  test("parseArgs: start is the default; options belong to their command", () => {
    assert.equal(parseArgs([]).opts.command, "start");
    assert.equal(parseArgs(["--no-open"]).opts.open, false);
    assert.equal(parseArgs(["stop", "--timeout", "12"]).opts.timeout, 12);
    assert.equal(parseArgs(["service", "install", "--yes"]).opts.yes, true);
    assert.deepEqual(parseArgs(["reset-login", "a@b.test"]).opts.args, ["a@b.test"]);
  });

  test("an older Node.js is refused with a clear message", async () => {
    const h = harness();
    h.deps.nodeVersion = "22.11.0";
    assert.equal(await h.run(["status"]), 1);
    assert.match(h.log.err.join("\n"), /needs Node\.js 24/);
  });
});

describe("first run and the settings file", () => {
  test("creates the home, data folder and .env once, with the installers' keys and fresh secrets", async () => {
    const h = harness();
    assert.equal(await h.run(["--no-open"]), 0);
    const text = fs.readFileSync(h.envFile, "utf8");
    const env = parseEnv(text);
    assert.equal(env.WATCHBELL_MODE, "selfhost");
    assert.equal(env.DATABASE_URL, "pglite:");
    assert.equal(env.WATCHBELL_DATA_DIR, "./data");
    assert.equal(env.HOST, "127.0.0.1");
    assert.equal(env.PORT, "3100");
    assert.equal(env.SITE_URL, "http://localhost:3100");
    assert.equal(Buffer.from(env.OPS_ENCRYPTION_KEY, "base64").length, 32);
    assert.ok(env.COLLECTOR_SECRET.length >= 32);
    assert.ok(env.CRON_SECRET.length >= 16);
    assert.equal(Buffer.from(env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY, "base64").length, 32);
    assert.ok(fs.statSync(h.dataDir).isDirectory());
    if (process.platform !== "win32") assert.equal(fs.statSync(h.envFile).mode & 0o777, 0o600);
    assert.ok(h.log.out.some((l) => l.includes("Created") && l.includes(".env")));
    assert.ok(!h.log.out.join("\n").includes(env.OPS_ENCRYPTION_KEY), "a secret was printed");

    // Second run: nothing changes.
    assert.equal(await h.run(["--no-open"]), 0);
    assert.equal(fs.readFileSync(h.envFile, "utf8"), text);
  });

  test("never changes a value that is set; fills empty keys in place and appends missing ones", async () => {
    const h = harness();
    fs.mkdirSync(h.home, { recursive: true });
    const before = "# mine\nPORT=4321\nOPS_ENCRYPTION_KEY=\nCRON_SECRET=keep-this-cron-secret\nWATCHPOST_DATA_DIR=./old-data\nTELEGRAM_BOT_TOKEN=\n";
    fs.writeFileSync(h.envFile, before);
    assert.equal(await h.run(["--no-open"]), 0);
    const text = fs.readFileSync(h.envFile, "utf8");
    const lines = text.split("\n");
    assert.equal(lines[0], "# mine");
    assert.equal(lines[1], "PORT=4321");
    assert.match(lines[2], /^OPS_ENCRYPTION_KEY=.{44}$/); // filled where it was
    assert.equal(lines[3], "CRON_SECRET=keep-this-cron-secret");
    assert.equal(lines[4], "WATCHPOST_DATA_DIR=./old-data");
    assert.equal(lines[5], "TELEGRAM_BOT_TOKEN=", "only Watchbell's own keys are filled");
    const env = parseEnv(text);
    assert.equal(env.SITE_URL, "http://localhost:4321", "SITE_URL follows the PORT that is set");
    assert.equal(env.WATCHBELL_DATA_DIR, undefined, "the old WATCHPOST_DATA_DIR counts");
    // The server got the old data folder, resolved from the home folder.
    assert.equal(h.log.spawns[0].opts.env.WATCHBELL_DATA_DIR, path.join(h.home, "old-data"));
    // And a third run leaves the file alone.
    assert.equal(await h.run(["--no-open"]), 0);
    assert.equal(fs.readFileSync(h.envFile, "utf8"), text);
  });

  test("on Windows the new .env is limited to the user's SID with icacls", async () => {
    const runs = [];
    const h = harness({
      platform: "win32",
      runSync: (cmd, args) => {
        runs.push([cmd, ...args]);
        return cmd === "C:\\Windows\\System32\\whoami.exe" ? { status: 0, stdout: '"pc\\me","S-1-5-21-1-2-3-1001"\r\n', stderr: "" } : { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(await h.run(["--no-open"]), 0);
    assert.equal(runs.filter(([c]) => c.endsWith("whoami.exe")).length, 1, "the SID is looked up once");
    // The home folder the CLI created (data/ inherits it), then the .env inside it.
    assert.deepEqual(runs[1], ["C:\\Windows\\System32\\icacls.exe", h.home, "/inheritance:r", "/grant:r", "*S-1-5-21-1-2-3-1001:(OI)(CI)F"]);
    assert.deepEqual(runs[2], ["C:\\Windows\\System32\\icacls.exe", h.envFile, "/inheritance:r", "/grant:r", "*S-1-5-21-1-2-3-1001:(R,W,D)"]);
    assert.ok(fs.readFileSync(h.envFile, "utf8").includes("\r\n"));
    assert.equal(await h.run(["--no-open"]), 0);
    assert.equal(runs.length, 3, "icacls runs only when the folder and the file are created");
  });

  test("the server gets absolute folders, the bind address and pglite (a DATABASE_URL in the shell is ignored)", async () => {
    const h = harness({ env: { DATABASE_URL: "postgres://dev@localhost/devdb", WATCHBELL_PORT: "3200", WATCHBELL_MODE: "cloud" } });
    assert.equal(await h.run(["--no-open"]), 0);
    const { cmd, args, opts } = h.log.spawns[0];
    assert.equal(cmd, "/usr/bin/node");
    assert.deepEqual(args, [path.join(h.pkgRoot, "server", "server.js")]);
    assert.equal(opts.cwd, path.join(h.pkgRoot, "server"));
    assert.equal(opts.env.DATABASE_URL, "pglite:");
    assert.equal(opts.env.WATCHBELL_MODE, "selfhost");
    assert.equal(opts.env.WATCHBELL_DATA_DIR, h.dataDir);
    assert.equal(opts.env.WATCHBELL_MIGRATIONS_DIR, path.join(h.pkgRoot, "server", "drizzle-selfhost"));
    assert.equal(opts.env.HOSTNAME, "127.0.0.1");
    assert.equal(opts.env.PORT, "3200", "WATCHBELL_PORT wins over the file");
    assert.equal(opts.env.SITE_URL, "http://localhost:3200", "the address the CLI wrote follows the port");
    assert.equal(opts.env.NEXT_MANUAL_SIG_HANDLE, "true");
    assert.ok(opts.env.OPS_ENCRYPTION_KEY, "settings from the file reach the server");
  });

  test("a DATABASE_URL in the settings file is used", async () => {
    const h = harness();
    fs.mkdirSync(h.home, { recursive: true });
    fs.writeFileSync(h.envFile, "DATABASE_URL=postgres://u:p@db.internal:5432/wb\n");
    assert.equal(await h.run(["--no-open"]), 0);
    assert.equal(h.log.spawns[0].opts.env.DATABASE_URL, "postgres://u:p@db.internal:5432/wb");
  });

  test("a HOST or PORT exported by the shell never moves Watchbell; WATCHBELL_HOST / WATCHBELL_PORT do", async () => {
    // tcsh exports HOST=<machine name>; Codespaces and many dotfiles export PORT.
    const h = harness({ env: { HOST: "my-laptop.lan", PORT: "3000", SITE_URL: "http://localhost:3000" } });
    assert.equal(await h.run(["--no-open"]), 0);
    let { env } = h.log.spawns[0].opts;
    assert.equal(env.HOSTNAME, "127.0.0.1");
    assert.equal(env.HOST, "127.0.0.1");
    assert.equal(env.PORT, "3100");
    assert.equal(env.SITE_URL, "http://localhost:3100");
    assert.ok(h.log.out.includes("Starting on http://localhost:3100 ..."), h.log.out.join("\n"));

    // The file decides when it says otherwise, and WATCHBELL_* overrides the file; the printed address follows.
    fs.writeFileSync(h.envFile, fs.readFileSync(h.envFile, "utf8").replace("PORT=3100", "PORT=3400").replace("SITE_URL=http://localhost:3100", "SITE_URL=http://localhost:3400"));
    h.deps.env.WATCHBELL_PORT = "3500";
    h.deps.env.WATCHBELL_HOST = "0.0.0.0";
    assert.equal(await h.run(["--no-open"]), 0);
    ({ env } = h.log.spawns[1].opts);
    assert.equal(env.PORT, "3500");
    assert.equal(env.HOSTNAME, "0.0.0.0");
    assert.equal(env.SITE_URL, "http://localhost:3500");
    assert.ok(h.log.out.includes("Starting on http://localhost:3500 ..."));
  });

  test("a shell HOST or PORT that differs from the file is named as ignored, with the override to use", async () => {
    const h = harness({ env: { HOST: "my-laptop.lan", PORT: "3000" } });
    assert.equal(await h.run(["--no-open"]), 0);
    const err = h.log.err.join("\n");
    assert.match(err, /PORT=3000 from your shell is ignored: Watchbell uses PORT=3100 from .+\.env\. Set WATCHBELL_PORT to override it\./);
    assert.match(err, /HOST=my-laptop\.lan from your shell is ignored: Watchbell uses HOST=127\.0\.0\.1 .+ WATCHBELL_HOST/);
    const same = harness({ env: { PORT: "3100" } });
    assert.equal(await same.run(["--no-open"]), 0);
    assert.equal(same.log.err.length, 0, "a shell value equal to the file says nothing");
  });

  test("a SITE_URL of the user's own is kept; one on this machine with another port is warned about", async () => {
    const h = harness();
    fs.mkdirSync(h.home, { recursive: true });
    fs.writeFileSync(h.envFile, "PORT=3100\nSITE_URL=https://ops.example.test\n");
    assert.equal(await h.run(["--no-open"]), 0);
    assert.equal(h.log.spawns[0].opts.env.SITE_URL, "https://ops.example.test");
    assert.equal(h.log.err.length, 0, h.log.err.join("\n"));
    fs.writeFileSync(h.envFile, "PORT=3100\nSITE_URL=http://localhost:3999\n");
    assert.equal(await h.run(["--no-open"]), 0);
    assert.match(h.log.err.join("\n"), /SITE_URL \(http:\/\/localhost:3999\) names port 3999, but Watchbell listens on port 3100/);
  });

  test("an invalid port is a clear error", async () => {
    const h = harness({ env: { WATCHBELL_PORT: "http" } });
    assert.equal(await h.run(["status"]), 1);
    assert.match(h.log.err.join("\n"), /PORT http is not a port number/);
  });

  test("WATCHBELL_HOME=~/wb (quoted in a dotfile, so not expanded) means the user's home", async () => {
    const h = harness();
    h.deps.env.WATCHBELL_HOME = "~/wb";
    assert.equal(await h.run(["status"]), 3);
    assert.ok(h.log.out.some((l) => l.includes(path.join(h.deps.homedir, "wb", ".env"))), h.log.out.join("\n"));
  });

  test("a missing OPS_ENCRYPTION_KEY next to an existing database is refused, unless --new-key", async () => {
    const h = harness();
    fs.mkdirSync(path.join(h.dataDir, "pg"), { recursive: true });
    fs.writeFileSync(h.envFile, "PORT=3100\nCRON_SECRET=keep-this-cron-secret\n");
    assert.equal(await h.run(["--no-open"]), 1);
    assert.match(h.log.err.join("\n"), /OPS_ENCRYPTION_KEY is missing/);
    assert.match(h.log.err.join("\n"), /watchbell start --new-key/);
    assert.equal(h.log.spawns.length, 0);
    assert.equal(fs.readFileSync(h.envFile, "utf8"), "PORT=3100\nCRON_SECRET=keep-this-cron-secret\n", "nothing was written");
    assert.equal(await h.run(["--no-open", "--new-key"]), 0);
    assert.equal(Buffer.from(parseEnv(fs.readFileSync(h.envFile, "utf8")).OPS_ENCRYPTION_KEY, "base64").length, 32);
    assert.match(h.log.err.join("\n"), /a new OPS_ENCRYPTION_KEY was written/);
    assert.equal(parseArgs(["status", "--new-key"]).errors.length, 1, "--new-key goes with start only");
  });

  test("the file is rewritten through a copy (no .tmp left, its mode kept) and the data folder is private", async () => {
    const h = harness();
    fs.mkdirSync(h.home, { recursive: true });
    fs.writeFileSync(h.envFile, "PORT=3100\n", { mode: 0o600 });
    assert.equal(await h.run(["--no-open"]), 0);
    assert.equal(fs.existsSync(`${h.envFile}.tmp`), false);
    assert.ok(parseEnv(fs.readFileSync(h.envFile, "utf8")).OPS_ENCRYPTION_KEY);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(h.envFile).mode & 0o777, 0o600);
      fs.chmodSync(h.dataDir, 0o755);
      assert.equal(await h.run(["--no-open"]), 0);
      assert.equal(fs.statSync(h.dataDir).mode & 0o777, 0o700, "data/ is limited to the user on every start");
    }
  });

  test("a home that can't be created ends in one line, not a stack trace", async () => {
    const h = harness();
    fs.mkdirSync(path.dirname(h.home), { recursive: true });
    fs.writeFileSync(h.home, "a file where the folder should be");
    assert.equal(await h.run(["--no-open"]), 1);
    assert.match(h.log.err.join("\n"), /^watchbell: could not set up .+: E[A-Z]+$/m);
    assert.equal(h.log.spawns.length, 0);
  });
});

describe("start", () => {
  test("a second start while one runs says so and starts nothing", async () => {
    const h = harness({ lockAlive: [777], fetch: healthy });
    holdLock(h.dataDir, 777);
    assert.equal(await h.run(["--no-open"]), 1);
    assert.match(h.log.err.join("\n"), /already running \(process 777/);
    assert.equal(h.log.spawns.length, 0);
  });

  test("a lock held by a live Node.js process with nothing answering names the file to delete", async () => {
    for (const processName of [() => "node", () => null]) {
      const h = harness({ lockAlive: [777], processName });
      holdLock(h.dataDir, 777);
      assert.equal(await h.run(["--no-open"]), 1);
      const err = h.log.err.join("\n");
      assert.match(err, /locked by process 777/);
      assert.ok(err.includes(`delete ${path.join(h.dataDir, "pg", ".watchpost.lock")}`), err);
      assert.equal(h.log.spawns.length, 0);
      assert.ok(fs.existsSync(path.join(h.dataDir, "pg", ".watchpost.lock")), "a lock that may be real is never removed");
    }
  });

  test("a lock whose pid now belongs to another program (reboot, crash) is removed and the start goes on", async () => {
    const h = harness({ lockAlive: [4321], processName: (pid) => (pid === 4321 ? "chrome.exe" : null) });
    existingSettings(h);
    holdLock(h.dataDir, 4321);
    assert.equal(await h.run(["--no-open"]), 0);
    assert.equal(h.log.spawns.length, 1);
    assert.equal(fs.existsSync(path.join(h.dataDir, "pg", ".watchpost.lock")), false);
    assert.match(h.log.out.join("\n"), /Removed a leftover database lock .+ process 4321 is now chrome\.exe, not Watchbell/);
  });

  test("a stale lock (its process is gone) does not block the start", async () => {
    const h = harness();
    existingSettings(h);
    holdLock(h.dataDir, 999);
    assert.equal(await h.run(["--no-open"]), 0);
    assert.equal(h.log.spawns.length, 1);
  });

  test("a port taken by another Watchbell or another program is reported", async () => {
    const other = harness({ fetch: healthy });
    assert.equal(await other.run(["--no-open"]), 1);
    assert.match(other.log.err.join("\n"), /Another Watchbell/);
    const prog = harness({ fetch: async () => new Response("<html>", { status: 200 }) });
    assert.equal(await prog.run(["--no-open"]), 1);
    assert.match(prog.log.err.join("\n"), /Port 3100 is already in use by another program/);
    assert.equal(other.log.spawns.length + prog.log.spawns.length, 0);
  });

  test("once ready it prints the URL and the setup code and opens /setup; --no-open does not open", async () => {
    for (const open of [true, false]) {
      let calls = 0;
      // Call 1 is the "port free?" check, call 2 the first readiness probe; the server is up (code written) at call 3.
      const h = harness({
        exitWith: null,
        fetch: async (...a) => {
          if (++calls < 3) throw new Error("down");
          fs.writeFileSync(path.join(h.dataDir, "setup-code"), "ABCDE-FGHIJ\n");
          return healthy(...a);
        },
      });
      const done = h.run(open ? [] : ["--no-open"]);
      while (!h.log.out.some((l) => l.startsWith("Watchbell is running"))) await new Promise((r) => setTimeout(r, 5));
      h.log.spawns[0].child.emit("exit", 0, null);
      assert.equal(await done, 0);
      const text = h.log.out.join("\n");
      assert.ok(text.includes("Watchbell is running at http://localhost:3100"), text);
      assert.ok(text.includes("http://localhost:3100/setup and enter the setup code ABCDE-FGHIJ"), text);
      assert.deepEqual(h.log.opened, open ? ["http://localhost:3100/setup"] : []);
    }
  });

  test("run (for a service manager) never opens a browser; POSIX signals are forwarded once", async () => {
    const h = harness({ exitWith: null, fetch: healthy });
    // The port check before the start sees a healthy Watchbell, so answer it only once the child exists.
    h.deps.fetch = async (...a) => (h.log.spawns.length ? healthy(...a) : Promise.reject(new Error("down")));
    const done = h.run(["run"]);
    while (!h.log.out.some((l) => l.startsWith("Watchbell is running"))) await new Promise((r) => setTimeout(r, 5));
    h.proc.emit("SIGTERM");
    h.proc.emit("SIGINT");
    const child = h.log.spawns[0].child;
    assert.deepEqual(child.signals, ["SIGTERM"]);
    child.emit("exit", null, "SIGTERM");
    assert.equal(await done, 143);
    assert.deepEqual(h.log.opened, []);
    assert.equal(h.proc.listenerCount("SIGTERM"), 0, "handlers are removed after the exit");
  });

  test("on Windows the launcher never signals the server (Ctrl-C reaches it directly)", async () => {
    const h = harness({ platform: "win32", exitWith: null });
    const done = h.run(["--no-open"]);
    while (!h.log.spawns.length) await new Promise((r) => setTimeout(r, 5));
    h.proc.emit("SIGINT");
    h.proc.emit("SIGBREAK");
    assert.deepEqual(h.log.spawns[0].child.signals, []);
    h.log.spawns[0].child.emit("exit", 0, null);
    assert.equal(await done, 0);
  });

  test("a package without a built server says how to get one", async () => {
    const h = harness();
    fs.rmSync(path.join(h.pkgRoot, "server"), { recursive: true });
    assert.equal(await h.run([]), 1);
    assert.match(h.log.err.join("\n"), /no built server/);
  });
});

describe("stop, status and reset-login", () => {
  test("stop runs the packaged stop-selfhost.mjs on the same data folder and address", async () => {
    const h = harness({ env: { WATCHBELL_PORT: "3300", PORT: "9999", HOST: "my-laptop.lan" } });
    fs.mkdirSync(h.home, { recursive: true });
    assert.equal(await h.run(["stop", "--timeout", "5"]), 0);
    const { args, opts } = h.log.spawns[0];
    assert.deepEqual(args, [path.join(h.pkgRoot, "scripts", "stop-selfhost.mjs"), "--timeout", "5"]);
    assert.equal(opts.cwd, h.pkgRoot, "a folder that always exists");
    assert.equal(opts.env.WATCHBELL_DATA_DIR, h.dataDir);
    assert.equal(opts.env.PORT, "3300");
    assert.equal(opts.env.HOST, "127.0.0.1");
  });

  test("stop before the first start says Watchbell is not running; a failed spawn is reported", async () => {
    const h = harness();
    assert.equal(await h.run(["stop"]), 0);
    assert.match(h.log.out.join("\n"), /Watchbell is not running \(there are no settings in .+ yet\)/);
    assert.equal(h.log.spawns.length, 0);
    fs.mkdirSync(h.home, { recursive: true });
    h.deps.spawn = () => {
      const child = new FakeChild();
      setImmediate(() => child.emit("error", new Error("spawn ENOENT")));
      return child;
    };
    assert.equal(await h.run(["stop"]), 1);
    assert.match(h.log.err.join("\n"), /watchbell: spawn ENOENT/);
  });

  test("status: 3 and 'not running' when stopped, 0 with the pid when the lock is held", async () => {
    const h = harness({ lockAlive: [555] });
    assert.equal(await h.run(["status"]), 3);
    assert.match(h.log.out[0], /not running/);
    holdLock(h.dataDir, 555);
    assert.equal(await h.run(["status"]), 0);
    assert.match(h.log.out.join("\n"), /running \(process 555\) at http:\/\/localhost:3100/);
    assert.match(h.log.out.join("\n"), /Nothing answers at .+ delete .+\.watchpost\.lock/);
    assert.equal(fs.existsSync(h.envFile), false, "status writes nothing");
    // Running and answering: one clear line, no lock hint and no "not running" (a real run found that slip).
    h.log.out.length = 0;
    h.deps.fetch = healthy;
    assert.equal(await h.run(["status"]), 0);
    assert.match(h.log.out[0], /^Watchbell is running \(process 555\) at/);
    assert.ok(!h.log.out.join("\n").includes("not running"), h.log.out.join("\n"));
    assert.ok(!h.log.out.join("\n").includes("Nothing answers"));
  });

  test("reset-login refuses without a database or while running, else runs the packaged tool", async () => {
    const h = harness({ lockAlive: [321] });
    const tool = path.join(h.pkgRoot, "tools", "reset-login.mjs");
    fs.mkdirSync(path.dirname(tool), { recursive: true });
    fs.writeFileSync(tool, "// stub\n");
    assert.equal(await h.run(["reset-login", "Owner@Example.test"]), 1);
    assert.match(h.log.err.at(-1), /No Watchbell database/);
    holdLock(h.dataDir, 321);
    assert.equal(await h.run(["reset-login", "Owner@Example.test"]), 1);
    assert.match(h.log.err.join("\n"), /Stop it first/);
    fs.rmSync(path.join(h.dataDir, "pg", ".watchpost.lock"));
    assert.equal(await h.run(["reset-login", "Owner@Example.test"]), 0);
    const { args, opts } = h.log.spawns[0];
    assert.deepEqual(args, [tool, "Owner@Example.test"]);
    assert.equal(opts.env.WATCHBELL_DATA_DIR, h.dataDir);
    assert.equal(opts.env.WATCHBELL_MODE, "selfhost");
    assert.equal(opts.env.WATCHBELL_MIGRATIONS_DIR, path.join(h.pkgRoot, "server", "drizzle-selfhost"));
  });
});

describe("service", () => {
  const linuxRuns = (log, { active = false, session = true } = {}) => (cmd, args) => {
    log.push([cmd, ...args].join(" "));
    if (args[1] === "show-environment") return { status: session ? 0 : 1, stdout: "", stderr: "" };
    if (args[1] === "is-active") return { status: active ? 0 : 3, stdout: "", stderr: "" };
    if (cmd === "loginctl") return { status: 0, stdout: "Linger=no\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };

  test("linux install: asks, writes the user unit and enables it; uninstall disables and deletes it", async () => {
    const calls = [];
    const h = harness({ runSync: linuxRuns(calls), ask: true });
    h.deps.env.XDG_CONFIG_HOME = path.join(h.root, "config");
    const unitFile = path.join(h.root, "config", "systemd", "user", "watchbell.service");
    assert.equal(await h.run(["service", "install"]), 0);
    assert.equal(h.log.asked.length, 1);
    const unit = fs.readFileSync(unitFile, "utf8");
    assert.ok(unit.startsWith("# Written by the watchbell CLI"));
    assert.ok(unit.includes(`ExecStart="/usr/bin/node" "${h.deps.cliPath.replaceAll("\\", "\\\\")}" run\n`), unit);
    assert.ok(unit.includes(`Environment="WATCHBELL_HOME=${h.home.replaceAll("\\", "\\\\")}"\n`), unit);
    assert.ok(unit.includes("KillSignal=SIGTERM") && unit.includes("WantedBy=default.target"));
    // A start that always fails (port taken, database locked) must not restart every 5 s forever.
    assert.match(unit, /\[Unit\][^[]*StartLimitIntervalSec=120\nStartLimitBurst=5\n/);
    assert.match(h.log.out.join("\n"), /run watchbell service install again/);
    assert.ok(fs.existsSync(h.envFile), "the settings exist before the service first starts");
    assert.deepEqual(calls.filter((c) => /reload|enable|restart/.test(c)), [
      "systemctl --user daemon-reload",
      "systemctl --user enable watchbell.service",
      "systemctl --user restart watchbell.service",
    ]);
    assert.match(h.log.out.join("\n"), /loginctl enable-linger/);

    calls.length = 0;
    assert.equal(await h.run(["service", "uninstall", "--yes"]), 0);
    assert.equal(fs.existsSync(unitFile), false);
    assert.deepEqual(calls, ["systemctl --user disable --now watchbell.service", "systemctl --user daemon-reload"]);
  });

  test("linux: no consent, no change; another folder's unit is replaced only on a yes and never removed", async () => {
    const calls = [];
    const h = harness({ runSync: linuxRuns(calls), ask: false });
    h.deps.env.XDG_CONFIG_HOME = path.join(h.root, "config");
    const unitFile = path.join(h.root, "config", "systemd", "user", "watchbell.service");
    assert.equal(await h.run(["service", "install"]), 1);
    assert.equal(fs.existsSync(unitFile), false);
    assert.equal(fs.existsSync(h.home), false);

    fs.mkdirSync(path.dirname(unitFile), { recursive: true });
    const theirs = "# Written by Watchbell install.sh.\n[Service]\nWorkingDirectory=/srv/watchbell/app\n";
    fs.writeFileSync(unitFile, theirs);
    assert.equal(await h.run(["service", "install"]), 1);
    assert.match(h.log.asked.at(-1), /Replace it/);
    assert.equal(fs.readFileSync(unitFile, "utf8"), theirs);
    assert.equal(await h.run(["service", "uninstall", "--yes"]), 1);
    assert.match(h.log.err.at(-1), /uninstall\.sh/);
    assert.equal(fs.readFileSync(unitFile, "utf8"), theirs);
    assert.equal(await h.run(["service", "install", "--yes"]), 0);
    assert.ok(fs.readFileSync(unitFile, "utf8").includes("watchbell CLI"));
  });

  test("linux: refused without a systemd user session, or while Watchbell runs in a terminal", async () => {
    const h = harness({ runSync: linuxRuns([], { session: false }) });
    assert.equal(await h.run(["service", "install", "--yes"]), 1);
    assert.match(h.log.err.at(-1), /no systemd user session/);
    const r = harness({ runSync: linuxRuns([]), lockAlive: [888] });
    r.deps.env.XDG_CONFIG_HOME = path.join(r.root, "config");
    holdLock(r.dataDir, 888);
    assert.equal(await r.run(["service", "install", "--yes"]), 1);
    assert.match(r.log.err.at(-1), /running in a terminal/);
  });

  test("the unit escapes %, $, quotes and backslashes", () => {
    const unit = systemdUnit({ home: "/home/a%b" }, { execPath: '/opt/n$de/"bin"/node', cliPath: "/x\\y/watchbell.mjs" });
    assert.ok(unit.includes("WorkingDirectory=/home/a%%b\n"));
    assert.ok(unit.includes('Environment="WATCHBELL_HOME=/home/a%%b"\n'));
    assert.ok(unit.includes('ExecStart="/opt/n$$de/\\"bin\\"/node" "/x\\\\y/watchbell.mjs" run\n'), unit);
  });

  test("windows install registers the per-user task like install.ps1; uninstall removes only ours", async () => {
    let state = "{}";
    const ps = [];
    const h = harness({
      platform: "win32",
      ask: true,
      runSync: (cmd, args, opts) => {
        if (cmd !== "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe") return { status: 0, stdout: '"pc\\me","S-1-5-21-9"', stderr: "" };
        ps.push({ script: args.at(-1), env: opts.env });
        return { status: 0, stdout: args.at(-1).includes("Get-ScheduledTask") ? `${state}\r\n` : "", stderr: "" };
      },
    });
    h.deps.execPath = "C:\\Program Files\\nodejs\\node.exe";
    h.deps.cliPath = "D:\\npm\\node_modules\\watchbell\\bin\\watchbell.mjs";
    h.deps.env.SystemRoot = "C:\\Windows";
    assert.equal(await h.run(["service", "install"]), 0);
    const reg = ps.find((p) => p.script.includes("Register-ScheduledTask"));
    assert.ok(reg.script.includes("-LogonType Interactive -RunLevel Limited"));
    assert.ok(reg.script.includes("-AtLogOn"));
    assert.equal(reg.env.WB_TASK, "Watchbell");
    assert.equal(reg.env.WB_EXECUTE, "C:\\Windows\\System32\\conhost.exe");
    assert.equal(reg.env.WB_WORKDIR, h.home);
    const log = path.win32.join(h.home, "watchbell.log");
    assert.equal(
      reg.env.WB_ARGUMENT,
      `--headless "C:\\Windows\\System32\\cmd.exe" /d /s /c "set "WATCHBELL_HOME=${h.home}" && "C:\\Program Files\\nodejs\\node.exe" "D:\\npm\\node_modules\\watchbell\\bin\\watchbell.mjs" run >> "${log}" 2>&1"`,
    );
    assert.equal(reg.env.WB_ARGUMENT, scheduledTaskAction({ home: h.home }, h.deps).argument);

    // Another folder's task (install.ps1's) is never removed by the CLI.
    state = JSON.stringify({ state: "Ready", dir: "D:\\apps\\watchbell\\app" });
    ps.length = 0;
    assert.equal(await h.run(["service", "uninstall", "--yes"]), 1);
    assert.ok(!ps.some((p) => p.script.includes("Unregister")));
    // Ours goes.
    state = JSON.stringify({ state: "Ready", dir: h.home });
    assert.equal(await h.run(["service", "uninstall", "--yes"]), 0);
    assert.ok(ps.some((p) => p.script.includes("Unregister-ScheduledTask")));
  });

  test("macOS: prints launchd instructions and installs nothing", async () => {
    const h = harness({ platform: "darwin" });
    assert.equal(await h.run(["service", "install"]), 0);
    const text = h.log.out.join("\n");
    assert.ok(text.includes("<key>ProgramArguments</key>") && text.includes("launchctl bootstrap"));
    assert.equal(h.log.runs.length, 0);
    assert.equal(fs.existsSync(h.home), false);
  });
});

describe("hardening", () => {
  test("Windows opens the browser through System32's cmd.exe by full path, never a bare name", () => {
    const how = browserCommand("http://localhost:3100/setup", "win32", { SystemRoot: "C:\\Windows" });
    assert.equal(how.cmd, "C:\\Windows\\System32\\cmd.exe");
    assert.ok(path.win32.isAbsolute(how.cmd));
    assert.deepEqual(how.args, ["/d", "/s", "/c", '"start "" "http://localhost:3100/setup""']);
    assert.equal(browserCommand("http://localhost:3100/", "win32", {}).cmd, "C:\\Windows\\System32\\cmd.exe");
    assert.equal(browserCommand("http://localhost:3100/", "darwin").cmd, "/usr/bin/open");
    // cmd expands %VAR% and !VAR! even inside quotes; such a URL is never handed to it.
    for (const bad of ["http://x/%PATH%", "http://x/!a!", 'http://x/"&calc', "http://x/a b", "file:///c:/x"]) assert.equal(browserCommand(bad, "win32", {}), null, bad);
  });

  test("every program the CLI and its helpers start on Windows is named by its full path", () => {
    const sources = [path.join(HERE, "watchbell.mjs"), ...["selfhost-lib.mjs", "stop-selfhost.mjs", "start-selfhost.mjs"].map((f) => path.join(APP, "scripts", f))];
    for (const file of sources) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/\b(?:spawn|spawnSync|execFile|execFileSync|runSync|run)\(\s*"([^"]+)"/g)) {
        // Linux-only tools may use PATH: a POSIX PATH lookup never looks in the current folder (Windows' does).
        if (["systemctl", "loginctl"].includes(m[1])) continue;
        assert.ok(m[1].startsWith("/"), `${path.basename(file)} starts "${m[1]}" by a bare name`);
      }
      // Every "<name>.exe" in code is joined to System32 right where it is named.
      for (const line of text.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l))) {
        for (const m of line.matchAll(/(.{0,40})"[\w\\.-]+\.exe"/g)) {
          assert.match(m[1], /(system32Tool\(d, |"System32", |join\(system32, )$/, `${path.basename(file)}: ${line.trim()}`);
        }
      }
    }
  });

  test("the CLI loads on an old Node.js far enough to say it needs Node.js 24 (no named import of new built-ins)", () => {
    const text = fs.readFileSync(path.join(HERE, "watchbell.mjs"), "utf8");
    assert.ok(!/import\s*\{[^}]*\bparseEnv\b[^}]*\}\s*from\s*"node:util"/.test(text));
    assert.match(text, /needs Node\.js 24 or newer/);
  });

  test("POSIX: SIGHUP (the terminal was closed) is forwarded once like SIGTERM, never twice", () => {
    const proc = new EventEmitter();
    const child = new FakeChild();
    const stop = superviseChild(child, { platform: "linux", proc, tty: true });
    proc.emit("SIGHUP");
    proc.emit("SIGTERM");
    proc.emit("SIGHUP");
    assert.deepEqual(child.signals, ["SIGHUP"]);
    stop();
    assert.equal(proc.listenerCount("SIGHUP"), 0);
    // nohup / a service manager (no terminal): a hang-up is ignored (Node resets nohup's "ignore", so a no-op handler
    // keeps it), and nothing is forwarded to the server.
    const quiet = new EventEmitter();
    const server = new FakeChild();
    superviseChild(server, { platform: "linux", proc: quiet, tty: false });
    assert.equal(quiet.listenerCount("SIGHUP"), 1);
    quiet.emit("SIGHUP");
    assert.deepEqual(server.signals, []);
    assert.equal(quiet.listenerCount("SIGTERM"), 1);
  });
});

describe("the database lock", () => {
  const alive = (pids) => (pid) => {
    if (!pids.includes(pid)) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  };
  const lockIn = (pid) => {
    const dir = scratch("lock");
    holdLock(dir, pid);
    return path.join(dir, "pg", ".watchpost.lock");
  };

  test("free when there is no lock or its process is gone", () => {
    assert.equal(inspectLock(path.join(scratch("lock"), "none"), { kill: alive([]) }).state, "free");
    assert.equal(inspectLock(lockIn(10), { kill: alive([]), processName: () => "node" }).state, "free");
  });

  test("held by a live Node.js process (any common name, Next's renamed server) or an unidentified one", () => {
    for (const name of ["node", "node.exe", "nodejs", "next-server (v16", "bun", null]) {
      const lock = inspectLock(lockIn(10), { kill: alive([10]), processName: () => name, execPath: "/usr/bin/node" });
      assert.deepEqual([lock.state, lock.pid], ["held", 10], String(name));
    }
    // EPERM: a process of another user exists; still checked by name.
    const eperm = () => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    };
    assert.equal(inspectLock(lockIn(10), { kill: eperm, processName: () => "node" }).state, "held");
    assert.equal(inspectLock(lockIn(1), { kill: eperm, processName: () => "systemd" }).state, "stale", "a root daemon that got the pid after a reboot");
  });

  test("stale when the pid is alive but is another program now", () => {
    const lock = inspectLock(lockIn(10), { kill: alive([10]), processName: () => "chrome.exe" });
    assert.deepEqual(lock, { state: "stale", pid: 10, name: "chrome.exe" });
    assert.equal(looksLikeServer("Code.exe", "C:\\Program Files\\nodejs\\node.exe"), false);
    assert.equal(looksLikeServer("NODE.EXE", "C:\\Program Files\\nodejs\\node.exe"), true);
  });

  test("processNameOf: System32 tasklist on Windows, /proc on Linux, /bin/ps on macOS; unknown is null", () => {
    const calls = [];
    const run = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '"chrome.exe","4321","Console","1","120,000 K"\r\n' };
    };
    assert.equal(processNameOf(4321, { platform: "win32", env: { SystemRoot: "C:\\Windows" }, run }), "chrome.exe");
    assert.deepEqual(calls[0], ["C:\\Windows\\System32\\tasklist.exe", "/fi", "PID eq 4321", "/fo", "csv", "/nh"]);
    assert.equal(processNameOf(99, { platform: "win32", env: {}, run }), null, "another pid in the answer");
    assert.equal(processNameOf(99, { platform: "win32", env: {}, run: () => ({ status: 0, stdout: "INFO: No tasks are running which match the specified criteria.\r\n" }) }), null);
    const proc = (files) => (p) => {
      const key = p.split("/").at(-1);
      if (!(key in files)) throw new Error("ENOENT");
      return files[key];
    };
    // Node.js on Linux: comm is "MainThread"; the program comes from cmdline.
    assert.equal(processNameOf(7, { platform: "linux", readFile: proc({ cmdline: "/usr/bin/node\0/x/bin/watchbell.mjs\0", comm: "MainThread\n" }) }), "node");
    assert.equal(processNameOf(7, { platform: "linux", readFile: proc({ cmdline: "next-server (v16.4.0)\0", comm: "MainThread\n" }) }), "next-server (v16.4.0)");
    assert.equal(processNameOf(7, { platform: "linux", readFile: proc({ cmdline: "", comm: "kworker/0:1\n" }) }), "kworker/0:1");
    assert.equal(looksLikeServer("MainThread"), true, "a comm fallback never calls Node.js stale");
    assert.equal(processNameOf(7, { platform: "linux", readFile: () => { throw new Error("EACCES"); } }), null);
    assert.equal(processNameOf(7, { platform: "darwin", run: (cmd) => ({ status: cmd === "/bin/ps" ? 0 : 1, stdout: "/opt/homebrew/bin/node\n" }) }), "node");
    assert.equal(processNameOf(7, { platform: "freebsd" }), null);
  });

  test("this machine: the test runner itself is recognised as Node.js", () => {
    const name = processNameOf(process.pid);
    if (name !== null) assert.ok(looksLikeServer(name), name);
  });
});

// ------------------------------------------------------------------------------------------------ real processes

const FAKE_SERVER = `
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const dataDir = process.env.WATCHBELL_DATA_DIR;
const lock = path.join(dataDir, "pg", ".watchpost.lock");
fs.mkdirSync(path.dirname(lock), { recursive: true });
fs.writeFileSync(lock, String(process.pid));
fs.writeFileSync(path.join(dataDir, "setup-code"), "QWERT-YUIOP\\n");
fs.writeFileSync(path.join(dataDir, "seen-env.json"), JSON.stringify({ cwd: process.cwd(), host: process.env.HOSTNAME, port: process.env.PORT, migrations: process.env.WATCHBELL_MIGRATIONS_DIR }));
const server = http.createServer((_q, res) => res.end(JSON.stringify({ ok: true, service: "watchbell" })));
server.listen(Number(process.env.PORT), process.env.HOSTNAME);
setInterval(() => {
  const req = path.join(dataDir, "stop-request");
  if (!fs.existsSync(req)) return;
  fs.rmSync(req, { force: true });
  server.close();
  fs.rmSync(lock, { force: true });
  process.exit(0);
}, 100);
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function listing(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)} ${fs.statSync(p).size} ${fs.statSync(p).mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort();
}

describe("the CLI file in a scratch package (real processes)", () => {
  test("start → ready with the setup code → second start refused → status → stop; nothing written in the package", async () => {
    const root = scratch("real");
    const pkg = path.join(root, "pkg dir");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.mkdirSync(path.join(pkg, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(pkg, "server", "drizzle-selfhost"), { recursive: true });
    fs.copyFileSync(path.join(HERE, "watchbell.mjs"), path.join(pkg, "bin", "watchbell.mjs"));
    for (const f of ["selfhost-lib.mjs", "stop-selfhost.mjs"]) fs.copyFileSync(path.join(APP, "scripts", f), path.join(pkg, "scripts", f));
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "watchbell", version: "9.8.7" }));
    fs.writeFileSync(path.join(pkg, "server", "server.js"), FAKE_SERVER);
    const before = listing(pkg);

    const home = path.join(root, "home");
    const port = await freePort();
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, ".env"), `PORT=${port}\nOPS_ENCRYPTION_KEY=${Buffer.alloc(32, 9).toString("base64")}\n`);
    // A lock left by a crash whose pid now belongs to another, live program (not Node.js): the start removes it.
    const other =
      process.platform === "win32"
        ? spawn(path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "PING.EXE"), ["-n", "60", "127.0.0.1"], { stdio: "ignore" })
        : spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    holdLock(path.join(home, "data"), other.pid);
    // Only what Node needs on Windows plus the case's own variables.
    const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", WATCHBELL_HOME: home };
    const cli = path.join(pkg, "bin", "watchbell.mjs");
    const sync = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", cwd: root });

    assert.equal(sync("--version").stdout.trim(), "9.8.7");

    const started = spawn(process.execPath, [cli, "--no-open"], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    started.stdout.on("data", (d) => (out += d));
    started.stderr.on("data", (d) => (out += d));
    const exited = new Promise((r) => started.on("exit", (code) => r(code)));
    const deadline = Date.now() + 20_000;
    while (!out.includes("Watchbell is running") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    try {
      assert.ok(out.includes(`Watchbell is running at http://localhost:${port}`), out);
      assert.match(out, new RegExp(`Removed a leftover database lock .+: process ${other.pid} is now (PING\\.EXE|sleep), not Watchbell`, "i"));
      assert.ok(out.includes("setup code QWERT-YUIOP"), out);
      const seen = JSON.parse(fs.readFileSync(path.join(home, "data", "seen-env.json"), "utf8"));
      assert.equal(seen.cwd, path.join(pkg, "server"));
      assert.equal(seen.host, "127.0.0.1");
      assert.equal(seen.port, String(port));

      const second = sync("--no-open");
      assert.equal(second.status, 1);
      assert.match(second.stderr, /already running/);

      const status = sync("status");
      assert.equal(status.status, 0, status.stdout + status.stderr);
      assert.match(status.stdout, /Watchbell is running \(process \d+\)/);

      const stopped = sync("stop");
      assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
      assert.match(stopped.stdout, /Watchbell stopped/);
      assert.equal(await exited, 0);
      assert.equal(fs.existsSync(path.join(home, "data", "pg", ".watchpost.lock")), false);
      assert.equal(sync("status").status, 3);
      assert.equal(sync("stop").status, 0, "stopping a stopped Watchbell is fine");
    } finally {
      if (started.exitCode === null) started.kill();
      other.kill();
    }
    assert.deepEqual(listing(pkg), before, "the CLI wrote inside the package folder");
    const settings = parseEnv(fs.readFileSync(path.join(home, ".env"), "utf8"));
    assert.equal(settings.PORT, String(port));
    assert.equal(settings.SITE_URL, `http://localhost:${port}`);
  });
});
