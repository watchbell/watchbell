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
import { browserCommand, COMMANDS, launchdPlist, main, parseArgs, scheduledTaskAction, serviceNodePath, systemdUnit } from "./watchbell.mjs";

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
    env: { WATCHBELL_HOME: home, WATCHBELL_NO_UPDATE_CHECK: "1", ...env }, // the update check is tested on its own
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

});

// ------------------------------------------------------------------------------------------------ Watchbell 1.1: service Node.js path, launchd on macOS

describe("macOS launchd agent", () => {
  /** launchctl stub: `print` answers whether the agent is loaded; every call is logged as one line. */
  const mac = ({ loaded = false, running = loaded, ask = false, lockAlive = [] } = {}) => {
    const calls = [];
    const state = { loaded, running, busyPolls: 0 };
    const h = harness({
      platform: "darwin",
      ask,
      lockAlive,
      runSync: (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        if (args[0] === "print") {
          // After a bootout the job can stay for a few polls while the server closes its database.
          if (!state.loaded && state.busyPolls > 0) {
            state.busyPolls--;
            return { status: 0, stdout: "\tstate = running\n", stderr: "" };
          }
          return { status: state.loaded ? 0 : 113, stdout: state.loaded ? `\tstate = ${state.running ? "running" : "not running"}\n` : "", stderr: "" };
        }
        if (args[0] === "bootstrap") Object.assign(state, { loaded: true, running: true });
        if (args[0] === "bootout") Object.assign(state, { loaded: false, running: false });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    h.deps.uid = 501;
    return { h, calls, state, plistFile: path.join(h.deps.homedir, "Library", "LaunchAgents", "watchbell.plist") };
  };

  test("install asks, writes ~/Library/LaunchAgents/watchbell.plist and bootstraps it into gui/<uid>", async () => {
    const { h, calls, plistFile } = mac({ ask: true });
    assert.equal(await h.run(["service", "install"]), 0);
    assert.equal(h.log.asked.length, 1);
    assert.match(h.log.asked[0], /Install the launchd agent watchbell/);
    const plist = fs.readFileSync(plistFile, "utf8");
    assert.equal(plist, `${launchdPlist({ home: h.home }, h.deps)}\n`);
    assert.ok(plist.includes("<!-- Written by the watchbell CLI"));
    assert.ok(plist.includes("<key>Label</key><string>watchbell</string>"));
    assert.ok(plist.includes(`<array><string>/usr/bin/node</string><string>${h.deps.cliPath}</string><string>run</string></array>`), plist);
    assert.ok(plist.includes("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>"));
    assert.deepEqual(calls, ["/bin/launchctl print gui/501/watchbell", `/bin/launchctl bootstrap gui/501 ${plistFile}`]);
    assert.ok(fs.existsSync(h.envFile), "the settings exist before the agent first starts");
    assert.match(h.log.out.join("\n"), /run watchbell service install again/);
  });

  test("re-install boots the loaded agent out first; uninstall boots it out and deletes the plist", async () => {
    const { h, calls, plistFile } = mac({ loaded: true });
    assert.equal(await h.run(["service", "install", "--yes"]), 0);
    assert.equal(h.log.asked.length, 0, "--yes does not ask");
    assert.deepEqual(calls, [
      "/bin/launchctl print gui/501/watchbell",
      "/bin/launchctl bootout gui/501/watchbell",
      "/bin/launchctl print gui/501/watchbell", // gone: bootstrap now
      `/bin/launchctl bootstrap gui/501 ${plistFile}`,
    ]);
    calls.length = 0;
    assert.equal(await h.run(["service", "uninstall", "--yes"]), 0);
    assert.deepEqual(calls, ["/bin/launchctl print gui/501/watchbell", "/bin/launchctl bootout gui/501/watchbell", "/bin/launchctl print gui/501/watchbell"]);
    assert.equal(fs.existsSync(plistFile), false);
    assert.match(h.log.out.at(-1), /Your settings and data stay/);
    calls.length = 0;
    assert.equal(await h.run(["service", "uninstall", "--yes"]), 0);
    assert.match(h.log.out.at(-1), /No launchd agent is installed/);
    assert.deepEqual(calls, []);
  });

  test("no consent: nothing written and launchctl never runs; another plist is replaced only on a yes", async () => {
    const { h, calls, plistFile } = mac({ ask: false });
    assert.equal(await h.run(["service", "install"]), 1);
    assert.equal(fs.existsSync(plistFile), false);
    assert.equal(fs.existsSync(h.home), false);
    assert.deepEqual(calls, []);
    fs.mkdirSync(path.dirname(plistFile), { recursive: true });
    const theirs = '<?xml version="1.0"?>\n<plist version="1.0"><dict><key>Label</key><string>watchbell</string></dict></plist>\n';
    fs.writeFileSync(plistFile, theirs);
    assert.equal(await h.run(["service", "install"]), 1);
    assert.match(h.log.asked.at(-1), /Replace it/);
    assert.equal(fs.readFileSync(plistFile, "utf8"), theirs);
    assert.equal(await h.run(["service", "uninstall"]), 1);
    assert.equal(fs.readFileSync(plistFile, "utf8"), theirs, "uninstall asks too");
    assert.deepEqual(calls, []);
  });

  test("refused while Watchbell runs in a terminal; a failed bootstrap is reported", async () => {
    const r = mac({ lockAlive: [808] });
    holdLock(r.h.dataDir, 808);
    assert.equal(await r.h.run(["service", "install", "--yes"]), 1);
    assert.match(r.h.log.err.at(-1), /running in a terminal/);
    assert.equal(fs.existsSync(r.plistFile), false);

    const f = mac();
    f.h.deps.runSync = (cmd, args) => (args[0] === "bootstrap" ? { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error\n" } : { status: args[0] === "print" ? 113 : 0, stdout: "", stderr: "" });
    assert.equal(await f.h.run(["service", "install", "--yes"]), 1);
    assert.match(f.h.log.err.join("\n"), /launchctl bootstrap gui\/501 .+ did not work: Bootstrap failed: 5/);
    assert.match(f.h.log.err.at(-1), /Run watchbell service install again/);
  });

  test("update: a running agent is stopped cleanly, updated, and kickstarted", async () => {
    const { h, calls } = mac({ loaded: true, lockAlive: [909] });
    assert.equal(await h.run(["service", "install", "--yes"]), 0);
    holdLock(h.dataDir, 909);
    registryFetch(h);
    calls.length = 0;
    const base = h.deps.runSync;
    h.deps.runSync = (cmd, args, opts) => {
      if (cmd === "/usr/bin/npm") {
        calls.push(`${cmd} ${args.join(" ")}`);
        fs.writeFileSync(path.join(h.pkgRoot, "package.json"), JSON.stringify({ name: "watchbell", version: "10.0.0" }));
        return { status: 0, stdout: "", stderr: "" };
      }
      return base(cmd, args, opts);
    };
    const spawned = h.log.spawns.length;
    assert.equal(await h.run(["update"]), 0, h.log.err.join("\n"));
    assert.equal(path.basename(h.log.spawns[spawned].args[0]), "stop-selfhost.mjs", "the clean stop");
    assert.deepEqual(calls, ["/bin/launchctl print gui/501/watchbell", "/usr/bin/npm install -g watchbell@latest", "/bin/launchctl kickstart gui/501/watchbell"]);
  });
});

describe("status: the service's Node.js", () => {
  const MISSING = "The service runs";
  const warning = (h) => h.log.err.filter((l) => l.startsWith(MISSING));

  test("linux: warns when the unit's Node.js is gone, silent when it exists or there is no unit of ours", async () => {
    const h = harness();
    h.deps.env.XDG_CONFIG_HOME = path.join(h.root, "config");
    const unitFile = path.join(h.root, "config", "systemd", "user", "watchbell.service");
    fs.mkdirSync(path.dirname(unitFile), { recursive: true });
    assert.equal(await h.run(["status"]), 3);
    assert.deepEqual(warning(h), [], "no unit");

    const gone = path.join(h.root, "old node", "bin", "node");
    fs.writeFileSync(unitFile, systemdUnit({ home: h.home }, { execPath: gone, cliPath: h.deps.cliPath }));
    assert.equal(await h.run(["status"]), 3, "the exit code stays");
    assert.deepEqual(warning(h), [`The service runs ${gone}, which no longer exists. Run: watchbell service install`]);

    // %, $, spaces and backslashes are unescaped from the unit before the check.
    const here = path.join(h.root, "n%o$de dir", "node");
    fs.mkdirSync(path.dirname(here), { recursive: true });
    fs.writeFileSync(here, "");
    h.log.err.length = 0;
    fs.writeFileSync(unitFile, systemdUnit({ home: h.home }, { execPath: here, cliPath: h.deps.cliPath }));
    assert.equal(await h.run(["status"]), 3);
    assert.deepEqual(warning(h), []);

    h.log.err.length = 0;
    fs.writeFileSync(unitFile, `# Written by Watchbell install.sh.\n[Service]\nExecStart="${gone}" server.js\n`);
    assert.equal(await h.run(["status"]), 3);
    assert.deepEqual(warning(h), [], "an installer's unit is not ours to judge");
  });

  test("windows: reads the Scheduled Task's command line through PowerShell", async () => {
    let answer = "{}";
    const scripts = [];
    const h = harness({
      platform: "win32",
      runSync: (cmd, args, opts) => {
        if (cmd.endsWith("powershell.exe")) {
          scripts.push({ script: args.at(-1), env: opts.env });
          return { status: 0, stdout: `${answer}\r\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    h.deps.env.SystemRoot = "C:\\Windows";
    const taskOf = (execPath, home = h.home) => JSON.stringify({ dir: home, args: scheduledTaskAction({ home }, { ...h.deps, execPath }).argument });
    assert.equal(await h.run(["status"]), 3);
    assert.deepEqual(warning(h), [], "no task");
    assert.ok(scripts[0].script.includes("Get-ScheduledTask") && scripts[0].script.includes("Arguments"));
    assert.equal(scripts[0].env.WB_TASK, "Watchbell");

    const gone = path.join(h.root, "nodejs-old", "node.exe");
    answer = taskOf(gone);
    assert.equal(await h.run(["status"]), 3);
    assert.deepEqual(warning(h), [`The service runs ${gone}, which no longer exists. Run: watchbell service install`]);

    h.log.err.length = 0;
    answer = taskOf(process.execPath);
    assert.equal(await h.run(["status"]), 3);
    assert.deepEqual(warning(h), []);

    answer = taskOf(gone, "D:\\apps\\watchbell\\app");
    assert.equal(await h.run(["status"]), 3);
    assert.deepEqual(warning(h), [], "another folder's task (install.ps1)");
    answer = "not json";
    assert.equal(await h.run(["status"]), 3);
    assert.deepEqual(warning(h), []);
  });

  test("macOS: reads the plist's ProgramArguments", async () => {
    const h = harness({ platform: "darwin", runSync: (cmd, args) => ({ status: args[0] === "print" ? 113 : 0, stdout: "", stderr: "" }) });
    h.deps.uid = 501;
    const gone = path.join(h.root, "Cellar", "node@24 & co", "bin", "node");
    h.deps.execPath = gone;
    assert.equal(await h.run(["service", "install", "--yes"]), 0);
    assert.equal(await h.run(["status"]), 3);
    assert.deepEqual(warning(h), [`The service runs ${gone}, which no longer exists. Run: watchbell service install`]);
    fs.mkdirSync(path.dirname(gone), { recursive: true });
    fs.writeFileSync(gone, "");
    h.log.err.length = 0;
    assert.equal(await h.run(["status"]), 3);
    assert.deepEqual(warning(h), []);
    assert.equal(serviceNodePath({ home: h.home }, h.deps), gone, "XML entities are read back");
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

// ------------------------------------------------------------------------------------------------ Watchbell 1.1: update notice, update, --host/--port, server-action key

const REGISTRY = "https://registry.npmjs.org/watchbell/latest";
const HOUR = 60 * 60 * 1000;

/** A fetch stub: the registry answers `version` (or runs `registry`), the health URL is down until the server exists. */
function registryFetch(h, { version = "10.0.0", registry } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    if (String(url) === REGISTRY) {
      calls.push({ url: String(url), init });
      if (registry) return registry(init);
      return new Response(JSON.stringify({ name: "watchbell", version }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (h.log.spawns.length) return healthy();
    throw new Error("ECONNREFUSED");
  };
  h.deps.fetch = fetch;
  delete h.deps.env.WATCHBELL_NO_UPDATE_CHECK;
  return calls;
}

/** Runs a start until `until` holds for the output, then lets the server exit. */
async function startUntil(h, argv, until = (out) => out.some((l) => l.startsWith("Watchbell is running"))) {
  const done = h.run(argv);
  const deadline = Date.now() + 10_000;
  while (!until(h.log.out, h.log.err)) {
    if (Date.now() > deadline) throw new Error(`timed out; out:\n${h.log.out.join("\n")}\nerr:\n${h.log.err.join("\n")}`);
    await new Promise((r) => setTimeout(r, 5));
  }
  h.log.spawns[0].child.emit("exit", 0, null);
  return done;
}

const NOTICE = /^A newer Watchbell is available: (\S+) \(this is 9\.9\.9\)\. Update with: watchbell update$/;
const notices = (h) => h.log.out.filter((l) => NOTICE.test(l));

describe("update notice (D8)", () => {
  test("status: a newer version prints one line; the same or an older one prints nothing", async () => {
    for (const [version, lines] of [["10.0.0", 1], ["9.10.0", 1], ["9.9.9", 0], ["9.9.8", 0], ["9.9.9-rc.1", 0], ["10.0.0-rc.1", 1]]) {
      const h = harness();
      fs.mkdirSync(h.home, { recursive: true });
      const calls = registryFetch(h, { version });
      assert.equal(await h.run(["status"]), 3, version);
      assert.equal(calls.length, 1, version);
      assert.equal(notices(h).length, lines, `${version}: ${h.log.out.join("\n")}`);
      assert.equal(h.log.err.length, 0, h.log.err.join("\n"));
    }
  });

  test("only a plain GET of the version document is sent (no ids, cookies or tokens)", async () => {
    const h = harness();
    const calls = registryFetch(h);
    await h.run(["status"]);
    assert.equal(calls[0].url, REGISTRY);
    assert.equal(calls[0].init.method, "GET");
    assert.deepEqual(Object.keys(calls[0].init.headers), ["accept"]);
    assert.equal(calls[0].init.body, undefined);
    assert.ok(calls[0].init.signal instanceof AbortSignal);
  });

  test("offline, an error answer, a non-version or a corrupt cache file: nothing alarming is printed", async () => {
    const answers = [
      () => Promise.reject(new TypeError("fetch failed")),
      async () => new Response("Service Unavailable", { status: 503 }),
      async () => new Response("<html>captive portal</html>", { status: 200 }),
      async () => new Response(JSON.stringify({ version: "latest; rm -rf /" }), { status: 200 }),
    ];
    for (const registry of answers) {
      const h = harness();
      fs.mkdirSync(h.home, { recursive: true });
      registryFetch(h, { registry });
      assert.equal(await h.run(["status"]), 3);
      assert.equal(notices(h).length, 0);
      assert.equal(h.log.err.length, 0, h.log.err.join("\n"));
    }
    // A corrupt cache is ignored and replaced by a fresh answer.
    const h = harness();
    fs.mkdirSync(h.home, { recursive: true });
    const cache = path.join(h.home, "update-check.json");
    fs.writeFileSync(cache, "{ not json");
    const calls = registryFetch(h);
    assert.equal(await h.run(["status"]), 3);
    assert.equal(calls.length, 1);
    assert.equal(notices(h).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(cache, "utf8")).latest, "10.0.0");
  });

  test("a registry that does not answer delays status by 3 s at most", async () => {
    const h = harness();
    let aborted = false;
    registryFetch(h, {
      registry: (init) =>
        new Promise(() => {
          init.signal.addEventListener("abort", () => (aborted = true));
        }),
    });
    const t0 = Date.now();
    assert.equal(await h.run(["status"]), 3);
    const took = Date.now() - t0;
    assert.ok(took >= 2900 && took < 4500, `took ${took} ms`);
    assert.ok(aborted, "the request is aborted at the deadline");
    assert.equal(notices(h).length, 0);
    assert.equal(h.log.err.length, 0);
  });

  test("the answer is kept for 24 h in <home>/update-check.json; a failed ask is remembered too", async () => {
    const h = harness();
    fs.mkdirSync(h.home, { recursive: true });
    const calls = registryFetch(h);
    let now = Date.UTC(2026, 9, 20, 12);
    h.deps.now = () => now;
    await h.run(["status"]);
    const cache = path.join(h.home, "update-check.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(cache, "utf8")), { checkedAt: "2026-10-20T12:00:00.000Z", latest: "10.0.0" });
    now += 23 * HOUR;
    await h.run(["status"]);
    assert.equal(calls.length, 1, "no second request within 24 h");
    assert.equal(notices(h).length, 2, "the cached answer still tells");
    now += 2 * HOUR;
    h.deps.fetch = async (url) => {
      if (String(url) === REGISTRY) calls.push({ url });
      throw new Error("offline");
    };
    await h.run(["status"]);
    assert.equal(calls.length, 2, "asked again after 24 h");
    assert.equal(notices(h).length, 3, "offline: the last known answer");
    assert.equal(JSON.parse(fs.readFileSync(cache, "utf8")).checkedAt, "2026-10-21T13:00:00.000Z");
    await h.run(["status"]);
    assert.equal(calls.length, 2, "the failed ask counts for 24 h");
    // A cache from the future (the clock was moved back) is asked again.
    now -= 48 * HOUR;
    await h.run(["status"]);
    assert.equal(calls.length, 3);
  });

  test("WATCHBELL_NO_UPDATE_CHECK, NO_UPDATE_NOTIFIER and CI each skip the request", async () => {
    for (const [key, value, asks] of [
      ["WATCHBELL_NO_UPDATE_CHECK", "1", 0],
      ["NO_UPDATE_NOTIFIER", "1", 0],
      ["CI", "true", 0],
      ["CI", "1", 0],
      ["CI", "false", 1],
      ["WATCHBELL_NO_UPDATE_CHECK", "0", 1],
    ]) {
      const h = harness();
      const calls = registryFetch(h);
      h.deps.env[key] = value;
      await h.run(["status"]);
      assert.equal(calls.length, asks, `${key}=${value}`);
    }
  });

  test("WATCHBELL_NO_UPDATE_CHECK in ~/.watchbell/.env skips the request too; the environment wins over the file", async () => {
    for (const [file, envValue, asks] of [["1", undefined, 0], ["true", undefined, 0], ["0", undefined, 1], ["1", "0", 1], ["0", "1", 0]]) {
      const h = harness();
      fs.mkdirSync(h.home, { recursive: true });
      fs.writeFileSync(path.join(h.home, ".env"), `WATCHBELL_MODE=selfhost\nWATCHBELL_NO_UPDATE_CHECK=${file}\n`);
      const calls = registryFetch(h);
      if (envValue !== undefined) h.deps.env.WATCHBELL_NO_UPDATE_CHECK = envValue;
      await h.run(["status"]);
      assert.equal(calls.length, asks, `file=${file} env=${envValue}`);
    }
    // start reads the same file (the request is made in the background while the server starts).
    const h = harness();
    fs.mkdirSync(h.home, { recursive: true });
    fs.writeFileSync(path.join(h.home, ".env"), "WATCHBELL_NO_UPDATE_CHECK=1\n");
    const calls = registryFetch(h);
    await startUntil(h, ["--no-open"]);
    assert.equal(calls.length, 0);
    assert.equal(notices(h).length, 0);
  });

  test("status before the first start asks but writes nothing", async () => {
    const h = harness();
    registryFetch(h);
    await h.run(["status"]);
    assert.equal(notices(h).length, 1);
    assert.equal(fs.existsSync(h.home), false);
  });

  test("start says it once the server is ready; a slow registry never holds the start back; run never asks", async () => {
    const h = harness({ exitWith: null });
    let release;
    const calls = registryFetch(h, { registry: () => new Promise((r) => (release = () => r(new Response(JSON.stringify({ version: "10.1.0" }), { status: 200 })))) });
    const done = h.run(["--no-open"]);
    while (!h.log.spawns.length) await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls.length, 1, "asked while the server starts");
    release();
    while (!notices(h).length) await new Promise((r) => setTimeout(r, 5));
    const out = h.log.out;
    assert.ok(out.findIndex((l) => l.startsWith("Watchbell is running")) < out.findIndex((l) => NOTICE.test(l)), out.join("\n"));
    h.log.spawns[0].child.emit("exit", 0, null);
    assert.equal(await done, 0);

    const r = harness({ exitWith: null });
    const none = registryFetch(r);
    assert.equal(await startUntil(r, ["run"]), 0);
    assert.equal(none.length, 0);
  });

  test("checkForUpdate never throws, even when the home can't be read", async () => {
    const { checkForUpdate } = await import("./watchbell.mjs");
    const h = harness();
    registryFetch(h);
    assert.equal(await checkForUpdate({ home: "\0bad" }, { ...h.deps, fetch: undefined }), null);
  });
});

describe("watchbell update (D9)", () => {
  const npmRuns = (log, { status = 0, stderr = "", bump, systemd } = {}) => (cmd, args, opts) => {
    log.push({ cmd, args, opts });
    if (systemd && cmd === "systemctl") return systemd(args);
    if (/npm(\.cmd)?$/.test(cmd) || args.at(-1)?.includes("npm.cmd")) {
      if (status === 0 && bump) bump();
      return { status, stdout: "", stderr };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const bumpTo = (h, version) => () => fs.writeFileSync(path.join(h.pkgRoot, "package.json"), JSON.stringify({ name: "watchbell", version }));

  test("runs the npm next to this Node.js: install -g watchbell@latest", async () => {
    const h = harness();
    const runs = [];
    h.deps.runSync = npmRuns(runs, { bump: bumpTo(h, "10.0.0") });
    registryFetch(h);
    assert.equal(await h.run(["update"]), 0);
    const npm = runs.filter((r) => r.cmd.endsWith("npm"));
    assert.equal(npm.length, 1);
    assert.equal(npm[0].cmd, "/usr/bin/npm");
    assert.deepEqual(npm[0].args, ["install", "-g", "watchbell@latest"]);
    assert.deepEqual(npm[0].opts.env, { ...h.deps.env, PATH: "/usr/bin" }, "this Node.js first on PATH (#!/usr/bin/env node)");
    assert.equal(npm[0].opts.maxBuffer, 64 * 1024 * 1024);
    assert.match(h.log.out.join("\n"), /Updated Watchbell 9\.9\.9 to 10\.0\.0\./);
  });

  test("on Windows npm.cmd runs through System32's cmd.exe", async () => {
    const h = harness({ platform: "win32" });
    const runs = [];
    h.deps.execPath = "C:\\Program Files\\nodejs\\node.exe";
    h.deps.env.SystemRoot = "C:\\Windows";
    const base = npmRuns(runs, { bump: bumpTo(h, "10.0.0") });
    h.deps.runSync = (cmd, args, opts) => (cmd.endsWith("powershell.exe") ? (runs.push({ cmd, args }), { status: 0, stdout: "{}\r\n", stderr: "" }) : base(cmd, args, opts));
    registryFetch(h);
    assert.equal(await h.run(["update"]), 0);
    const npm = runs.find((r) => r.cmd === "C:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(npm.args, ["/d", "/s", "/c", '""C:\\Program Files\\nodejs\\npm.cmd" install -g watchbell@latest"']);
    assert.equal(npm.opts.windowsVerbatimArguments, true);
    // A path cmd would expand is never put on its command line.
    const bad = harness({ platform: "win32" });
    bad.deps.execPath = "C:\\100%\\node.exe";
    bad.deps.runSync = h.deps.runSync;
    registryFetch(bad);
    assert.equal(await bad.run(["update"]), 1);
    assert.match(bad.log.err.join("\n"), /npm install -g watchbell@latest/);
  });

  test("already the latest: says so and runs nothing", async () => {
    const h = harness();
    const runs = [];
    h.deps.runSync = npmRuns(runs);
    registryFetch(h, { version: "9.9.9" });
    assert.equal(await h.run(["update"]), 0);
    assert.deepEqual(h.log.out, ["Watchbell 9.9.9 is the latest version."]);
    assert.equal(runs.length, 0);
  });

  test("the update asks the registry even with the notice turned off, and runs npm when the registry can't be reached", async () => {
    const h = harness();
    const runs = [];
    h.deps.runSync = npmRuns(runs);
    const calls = registryFetch(h, { registry: () => Promise.reject(new Error("offline")) });
    h.deps.env.WATCHBELL_NO_UPDATE_CHECK = "1";
    assert.equal(await h.run(["update"]), 0);
    assert.equal(calls.length, 1);
    assert.equal(runs.filter((r) => r.cmd.endsWith("npm")).length, 1);
    assert.match(h.log.out.join("\n"), /Watchbell 9\.9\.9 is up to date\./);
  });

  test("while Watchbell runs (no service): exit 1 with the stop hint, nothing installed", async () => {
    const h = harness({ lockAlive: [654] });
    const runs = [];
    h.deps.runSync = npmRuns(runs);
    registryFetch(h);
    holdLock(h.dataDir, 654);
    assert.equal(await h.run(["update"]), 1);
    assert.match(h.log.err.join("\n"), /Watchbell is running \(process 654\)\. Stop it first with "watchbell stop"/);
    assert.equal(runs.length, 0);
  });

  test("npm fails: exit 1 with the exact command; on POSIX a permission error adds the sudo hint", async () => {
    for (const [platform, stderr, sudo] of [["linux", "npm error code EACCES\nnpm error path /usr/lib/node_modules/watchbell", true], ["linux", "npm error 404", false], ["win32", "npm error code EPERM", false]]) {
      const h = harness({ platform });
      const runs = [];
      const fail = npmRuns(runs, { status: 1, stderr });
      h.deps.runSync = (cmd, args, opts) => (cmd.endsWith("powershell.exe") ? { status: 0, stdout: "{}", stderr: "" } : fail(cmd, args, opts));
      registryFetch(h);
      assert.equal(await h.run(["update"]), 1, platform);
      const err = h.log.err.join("\n");
      assert.ok(err.includes(stderr), "npm's own message is shown");
      assert.match(err, /npm could not update Watchbell \(exit 1\)\.\nRun it yourself: npm install -g watchbell@latest/);
      assert.equal(err.includes("sudo npm install -g watchbell@latest"), sudo, `${platform} ${stderr}`);
    }
    // No npm next to this Node.js.
    const h = harness();
    h.deps.runSync = () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawnSync /usr/bin/npm ENOENT"), { code: "ENOENT" }) });
    registryFetch(h);
    assert.equal(await h.run(["update"]), 1);
    assert.match(h.log.err.join("\n"), /Could not run \/usr\/bin\/npm: ENOENT\.\nRun it yourself: npm install -g watchbell@latest/);
  });

  test("POSIX: an npm folder this user can't write is said before anything is stopped", { skip: process.platform === "win32" ? "POSIX file modes" : false }, async () => {
    const h = harness();
    const runs = [];
    h.deps.runSync = npmRuns(runs);
    registryFetch(h);
    const folder = path.dirname(h.pkgRoot);
    fs.chmodSync(folder, 0o555);
    try {
      if (process.getuid?.() === 0) return; // root writes anywhere
      assert.equal(await h.run(["update"]), 1);
      assert.match(h.log.err.join("\n"), /sudo npm install -g watchbell@latest/);
      assert.equal(runs.length, 0);
    } finally {
      fs.chmodSync(folder, 0o755);
    }
  });

  test("linux: a running service of the package is stopped, updated, and started again", async () => {
    const h = harness({ lockAlive: [700] });
    holdLock(h.dataDir, 700); // the service holds the database
    h.deps.env.XDG_CONFIG_HOME = path.join(h.root, "config");
    const unitFile = path.join(h.root, "config", "systemd", "user", "watchbell.service");
    fs.mkdirSync(path.dirname(unitFile), { recursive: true });
    fs.writeFileSync(unitFile, systemdUnit({ home: h.home }, h.deps));
    const runs = [];
    h.deps.runSync = npmRuns(runs, { bump: bumpTo(h, "10.0.0"), systemd: () => ({ status: 0, stdout: "", stderr: "" }) });
    registryFetch(h);
    assert.equal(await h.run(["update"]), 0, h.log.err.join("\n"));
    assert.deepEqual(
      runs.map((r) => [r.cmd, ...r.args].join(" ")),
      ["systemctl --user is-active --quiet watchbell.service", "systemctl --user stop watchbell.service", "/usr/bin/npm install -g watchbell@latest", "systemctl --user start watchbell.service"],
    );
    // npm failed: the service is started again on the old version.
    runs.length = 0;
    h.deps.runSync = npmRuns(runs, { status: 1, systemd: () => ({ status: 0, stdout: "", stderr: "" }) });
    fs.writeFileSync(path.join(h.pkgRoot, "package.json"), JSON.stringify({ name: "watchbell", version: "9.9.9" }));
    assert.equal(await h.run(["update"]), 1);
    assert.equal(runs.at(-1).args.join(" "), "--user start watchbell.service");
    // An installer's unit (another folder's checkout) or a stopped service is left alone.
    fs.writeFileSync(unitFile, "# Written by Watchbell install.sh.\n[Service]\nWorkingDirectory=/srv/watchbell/app\n");
    runs.length = 0;
    assert.equal(await h.run(["update"]), 1, "the lock is held, so it says stop first");
    assert.ok(!runs.some((r) => r.args.includes("stop")));
  });

  test("windows: the package's running Scheduled Task is stopped cleanly, updated, and started again", async () => {
    const h = harness({ platform: "win32", lockAlive: [701] });
    holdLock(h.dataDir, 701);
    h.deps.env.SystemRoot = "C:\\Windows";
    h.deps.execPath = "C:\\nodejs\\node.exe";
    const order = [];
    const ps = [];
    h.deps.runSync = (cmd, args, opts) => {
      if (cmd.endsWith("powershell.exe")) {
        ps.push({ script: args.at(-1), env: opts.env });
        order.push(args.at(-1).split("\n")[0].split(" ")[0].replace(/^\$t$/, "query"));
        const query = args.at(-1).includes("Get-ScheduledTask");
        return { status: 0, stdout: query ? `${JSON.stringify({ state: "Running", dir: h.home })}\r\n` : "", stderr: "" };
      }
      if (cmd.endsWith("cmd.exe")) {
        order.push("npm");
        bumpTo(h, "10.0.0")();
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    h.deps.spawn = (cmd, args, opts) => {
      order.push(`spawn ${path.basename(args[0])}`);
      const child = new FakeChild();
      h.log.spawns.push({ cmd, args, opts, child });
      setImmediate(() => child.emit("exit", 0, null));
      return child;
    };
    registryFetch(h);
    assert.equal(await h.run(["update"]), 0, h.log.err.join("\n"));
    assert.deepEqual(order, ["query", "spawn stop-selfhost.mjs", "npm", "Start-ScheduledTask"]);
    assert.equal(ps.at(-1).env.WB_TASK, "Watchbell");
  });

  test("only the npm package updates itself", async () => {
    const h = harness();
    fs.writeFileSync(path.join(h.pkgRoot, "package.json"), JSON.stringify({ name: "app", version: "0.1.0" }));
    assert.equal(await h.run(["update"]), 1);
    assert.match(h.log.err.join("\n"), /not the npm package/);
    assert.equal(parseArgs(["update", "now"]).errors.length, 1, "update takes no argument");
  });
});

describe("--host and --port (D10)", () => {
  const nics = () => ({
    eth0: [
      { address: "192.168.1.20", family: "IPv4", internal: false },
      { address: "fe80::1c2a", family: "IPv6", internal: false },
      { address: "2001:db8::20", family: "IPv6", internal: false },
    ],
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  });
  const lanHarness = (env) => {
    const h = harness({ exitWith: null, env });
    h.deps.fetch = async () => (h.log.spawns.length ? healthy() : Promise.reject(new Error("down")));
    h.deps.networkInterfaces = nics;
    return h;
  };

  test("parseArgs: a port must be 1-65535, a host an address; both go with start and run only", () => {
    for (const bad of [["--port", "0"], ["--port", "70000"], ["--port", "abc"], ["--port"], ["--port", "--no-open"], ["--port=", "start"], ["--host"], ["--host", "--port"], ["--host", "a b"], ["--host", "x;rm"]]) {
      const { errors } = parseArgs(bad);
      assert.ok(errors.length >= 1, bad.join(" "));
    }
    assert.match(parseArgs(["--port", "abc"]).errors.join(), /--port needs a port number \(1-65535\)/);
    assert.equal(parseArgs(["--port", "abc"]).errors.length, 1, "the wrong value is not read as a command");
    assert.deepEqual(pick(parseArgs(["--host", "0.0.0.0", "--port", "3200"])), { command: "start", host: "0.0.0.0", port: "3200", errors: [] });
    assert.deepEqual(pick(parseArgs(["run", "--port=3300", "--host=[::]"])), { command: "run", host: "::", port: "3300", errors: [] });
    assert.deepEqual(pick(parseArgs(["start", "--host", "my-box.lan", "--port", "08080"])), { command: "start", host: "my-box.lan", port: "8080", errors: [] });
    assert.deepEqual(parseArgs(["status", "--port", "3200"]).errors, ["--port only goes with watchbell start or watchbell run"]);
    assert.deepEqual(parseArgs(["stop", "--no-open"]).errors, ["--no-open only goes with watchbell start"], "single-command options keep their message");
  });
  const pick = ({ opts, errors }) => ({ command: opts.command, host: opts.host, port: opts.port, errors });

  test("a bad --port exits 2 before anything is touched", async () => {
    for (const v of ["0", "70000", "abc"]) {
      const h = harness();
      assert.equal(await h.run(["--port", v]), 2);
      assert.equal(fs.existsSync(h.home), false);
    }
  });

  test("--host 0.0.0.0 --port: wins over .env and WATCHBELL_* for this run, lists the addresses, warns, names SITE_URL", async () => {
    const h = lanHarness({ WATCHBELL_PORT: "3500", WATCHBELL_HOST: "127.0.0.1" });
    assert.equal(await startUntil(h, ["--no-open", "--host", "0.0.0.0", "--port", "3300"], (_o, err) => err.some((l) => l.startsWith("note: SITE_URL"))), 0);
    const { env } = h.log.spawns[0].opts;
    assert.equal(env.HOSTNAME, "0.0.0.0");
    assert.equal(env.HOST, "0.0.0.0");
    assert.equal(env.PORT, "3300");
    assert.equal(env.SITE_URL, "http://localhost:3300", "the SITE_URL the CLI wrote follows the port");
    const out = h.log.out.join("\n");
    assert.ok(out.includes("Starting on http://localhost:3300 ..."), out);
    assert.ok(out.includes("Watchbell listens on 0.0.0.0, so other computers can open it at:\n  http://192.168.1.20:3300"), out);
    assert.ok(!out.includes("fe80") && !out.includes("127.0.0.1:3300") && !out.includes("2001:db8"), "0.0.0.0 is IPv4 only, never loopback or link-local");
    const err = h.log.err.join("\n");
    assert.match(err, /^warning: everyone who can reach these addresses gets the Watchbell sign-in page/m);
    assert.match(err, /Finish \/setup/);
    assert.match(err, /SSH\ntunnel|SSH tunnel/);
    assert.ok(err.includes(`set SITE_URL=http://192.168.1.20:3300 in ${h.envFile}`), err);
    // For this run only: the file keeps its own address.
    const file = parseEnv(fs.readFileSync(h.envFile, "utf8"));
    assert.equal(file.HOST, "127.0.0.1");
    assert.equal(file.PORT, "3100");
    assert.equal(file.SITE_URL, "http://localhost:3100");
  });

  test(":: lists IPv6 addresses too; a single address is listed as it is; run prints it for the service log", async () => {
    const h = lanHarness();
    assert.equal(await startUntil(h, ["run", "--host", "::"], (_o, err) => err.some((l) => l.startsWith("note:"))), 0);
    const out = h.log.out.join("\n");
    assert.ok(out.includes("  http://192.168.1.20:3100\n  http://[2001:db8::20]:3100"), out);
    const one = lanHarness();
    assert.equal(await startUntil(one, ["--no-open", "--host", "192.168.1.20"], (_o, err) => err.some((l) => l.startsWith("tunnel"))), 0);
    assert.ok(one.log.out.join("\n").includes("open it at:\n  http://192.168.1.20:3100"));
    assert.ok(!one.log.err.some((l) => l.startsWith("note:")), "SITE_URL already names that address");
  });

  test("a loopback host prints no addresses and no warning; a SITE_URL of the user's own gets no note", async () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      const h = lanHarness();
      assert.equal(await startUntil(h, ["--no-open", "--host", host]), 0);
      assert.equal(h.log.err.length, 0, `${host}: ${h.log.err.join("\n")}`);
      assert.ok(!h.log.out.join("\n").includes("other computers"));
      assert.equal(h.log.spawns[0].opts.env.HOSTNAME, host);
    }
    const h = lanHarness();
    fs.mkdirSync(h.home, { recursive: true });
    fs.writeFileSync(h.envFile, "SITE_URL=https://ops.example.test\n");
    assert.equal(await startUntil(h, ["--no-open", "--host", "0.0.0.0"], (_o, err) => err.some((l) => l.startsWith("tunnel"))), 0);
    assert.ok(!h.log.err.some((l) => l.startsWith("note:")), h.log.err.join("\n"));
    assert.equal(h.log.spawns[0].opts.env.SITE_URL, "https://ops.example.test");
  });

  test("a shell HOST that differs is named as ignored in favour of --host", async () => {
    const h = lanHarness({ HOST: "my-laptop.lan" });
    assert.equal(await startUntil(h, ["--no-open", "--host", "127.0.0.1", "--port", "3600"]), 0);
    assert.match(h.log.err.join("\n"), /HOST=my-laptop\.lan from your shell is ignored: Watchbell uses HOST=127\.0\.0\.1 from --host\./);
  });

  test("--help lists update, --host and --port", async () => {
    const h = harness();
    await h.run(["--help"]);
    const help = h.log.out.join("\n");
    for (const s of ["watchbell update", "--host <addr>", "--port <n>", "WATCHBELL_NO_UPDATE_CHECK"]) assert.ok(help.includes(s), s);
  });
});

describe("per-install server-action key (D12)", () => {
  const keyOf = (file) => parseEnv(fs.readFileSync(file, "utf8")).NEXT_SERVER_ACTIONS_ENCRYPTION_KEY;

  test("first run writes a 44-character base64 key (32 bytes) and the server gets it", async () => {
    const h = harness();
    assert.equal(await h.run(["--no-open"]), 0);
    const key = keyOf(h.envFile);
    assert.match(key, /^[A-Za-z0-9+/]{43}=$/);
    assert.equal(Buffer.from(key, "base64").length, 32);
    assert.equal(h.log.spawns[0].opts.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY, key);
  });

  test("an existing .env without it gets it once; a set value is never changed; two homes differ", async () => {
    const h = harness();
    existingSettings(h);
    assert.equal(await h.run(["--no-open"]), 0);
    const key = keyOf(h.envFile);
    assert.equal(Buffer.from(key, "base64").length, 32);
    assert.match(h.log.out.join("\n"), /Added missing settings to .+NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/);
    const text = fs.readFileSync(h.envFile, "utf8");
    assert.equal(text.split("NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=").length, 2, "written once");
    assert.equal(await h.run(["--no-open"]), 0);
    assert.equal(fs.readFileSync(h.envFile, "utf8"), text);
    assert.equal(h.log.spawns[1].opts.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY, key);

    const own = harness();
    fs.mkdirSync(own.home, { recursive: true });
    const mine = Buffer.alloc(32, 3).toString("base64");
    fs.writeFileSync(own.envFile, `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=${mine}\n`);
    assert.equal(await own.run(["--no-open"]), 0);
    assert.equal(keyOf(own.envFile), mine);
    assert.equal(own.log.spawns[0].opts.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY, mine);

    const second = harness();
    existingSettings(second);
    assert.equal(await second.run(["--no-open"]), 0);
    assert.notEqual(keyOf(second.envFile), key, "every home gets its own key");
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
    const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", WATCHBELL_HOME: home, WATCHBELL_NO_UPDATE_CHECK: "1" };
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

describe("time zone on first run (1.1)", () => {
  test("a new .env gets this computer's zone as WATCHBELL_TIMEZONE, and the server gets it", async () => {
    const h = harness();
    h.deps.timeZone = () => "Europe/Berlin";
    assert.equal(await h.run(["--no-open"]), 0);
    const text = fs.readFileSync(h.envFile, "utf8");
    assert.equal(parseEnv(text).WATCHBELL_TIMEZONE, "Europe/Berlin");
    assert.equal(text.match(/^WATCHBELL_TIMEZONE=/gm)?.length, 1);
    assert.equal(h.log.spawns[0].opts.env.WATCHBELL_TIMEZONE, "Europe/Berlin");
    // Later runs never touch it, even when the computer's zone has changed since.
    h.deps.timeZone = () => "America/New_York";
    assert.equal(await h.run(["--no-open"]), 0);
    assert.equal(fs.readFileSync(h.envFile, "utf8"), text);
  });

  test("an existing .env is left without it (the app's default, Asia/Jakarta, stays)", async () => {
    const h = harness();
    existingSettings(h);
    h.deps.timeZone = () => "Europe/Berlin";
    assert.equal(await h.run(["--no-open"]), 0);
    const env = parseEnv(fs.readFileSync(h.envFile, "utf8"));
    assert.equal(env.WATCHBELL_TIMEZONE, undefined);
    assert.equal(h.log.spawns[0].opts.env.WATCHBELL_TIMEZONE, undefined);
  });

  test("a zone Intl can't name or doesn't know writes nothing, and the start goes on", async () => {
    for (const zone of [() => "", () => "Not/AZone", () => "Europe/Berlin; rm -rf", () => "CET", () => "IST", () => "BST", () => "AET", () => "ECT", () => "EST", () => "EST5EDT", () => "GB", () => undefined, () => { throw new Error("no ICU"); }]) {
      const h = harness();
      h.deps.timeZone = zone;
      assert.equal(await h.run(["--no-open"]), 0);
      assert.ok(!fs.readFileSync(h.envFile, "utf8").includes("WATCHBELL_TIMEZONE"));
    }
  });

  test("without a stub it is Intl's zone of this process", async () => {
    const { machineTimeZone } = await import("./watchbell.mjs");
    assert.equal(machineTimeZone({}), Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(machineTimeZone({ timeZone: () => "Asia/Kathmandu" }), "Asia/Kathmandu");
    // ICU's older names are written by their current name; an offset is never written.
    assert.equal(machineTimeZone({ timeZone: () => "Asia/Calcutta" }), "Asia/Kolkata");
    assert.equal(machineTimeZone({ timeZone: () => "Asia/Katmandu" }), "Asia/Kathmandu");
    assert.equal(machineTimeZone({ timeZone: () => "+07:00" }), null);
    // The same name rule as lib/time.ts: full Area/Location names and UTC/GMT, never an abbreviation.
    for (const ok of ["UTC", "GMT", "Etc/UTC", "Etc/GMT-7", "Etc/GMT+5", "US/Pacific", "America/Argentina/Buenos_Aires"]) {
      assert.equal(machineTimeZone({ timeZone: () => ok }), ok, ok);
    }
    for (const bad of ["IST", "CET", "BST", "AET", "ECT", "EST", "PST", "EST5EDT", "GB"]) {
      assert.equal(machineTimeZone({ timeZone: () => bad }), null, bad);
    }
  });
});

// D12 against the real prebuilt server: set WATCHBELL_TEST_PACKAGE to a built package folder (scripts/export/pack.mjs
// output, the one with server/server.js). Skipped otherwise: a build is minutes, and test:cli must stay quick.
const BUILT = process.env.WATCHBELL_TEST_PACKAGE?.trim();

describe("the server-action key with the real server", { skip: BUILT ? false : "set WATCHBELL_TEST_PACKAGE to a built watchbell package" }, () => {
  test("two homes get different keys, and a server action still runs under each", { timeout: 600_000 }, async () => {
    const root = scratch("real-key");
    const pkg = path.join(root, "pkg");
    fs.cpSync(path.join(BUILT, "server"), path.join(pkg, "server"), { recursive: true });
    fs.mkdirSync(path.join(pkg, "bin"));
    fs.mkdirSync(path.join(pkg, "scripts"));
    fs.copyFileSync(path.join(HERE, "watchbell.mjs"), path.join(pkg, "bin", "watchbell.mjs"));
    for (const f of ["selfhost-lib.mjs", "stop-selfhost.mjs"]) fs.copyFileSync(path.join(APP, "scripts", f), path.join(pkg, "scripts", f));
    fs.copyFileSync(path.join(BUILT, "package.json"), path.join(pkg, "package.json"));
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, "server", ".next", "server", "server-reference-manifest.json"), "utf8"));
    const [actionId] = Object.entries(manifest.node).find(([, a]) => a.filename === "src/app/setup/actions.ts" && a.exportedName === "submitSetup");
    const cli = path.join(pkg, "bin", "watchbell.mjs");
    const keys = [];
    for (const name of ["a", "b"]) {
      const home = path.join(root, `home ${name}`);
      const port = await freePort();
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, ".env"), `PORT=${port}\n`);
      const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", WATCHBELL_HOME: home, WATCHBELL_NO_UPDATE_CHECK: "1" };
      const started = spawn(process.execPath, [cli, "--no-open"], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      started.stdout.on("data", (d) => (out += d));
      started.stderr.on("data", (d) => (out += d));
      const exited = new Promise((r) => started.on("exit", (code) => r(code)));
      try {
        const deadline = Date.now() + 180_000;
        while (!out.includes("Watchbell is running") && started.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
        assert.ok(out.includes("Watchbell is running"), out);
        const key = parseEnv(fs.readFileSync(path.join(home, ".env"), "utf8")).NEXT_SERVER_ACTIONS_ENCRYPTION_KEY;
        assert.equal(Buffer.from(key, "base64").length, 32);
        keys.push(key);
        // submitSetup(prevState, formData) as React's encodeReply sends it: the FormData's fields as _1_<name> first, then
        // the arguments in field 0 ("$K1" names that FormData). The server reads the fields as they stream in, so order counts.
        const body = new FormData();
        for (const [k, v] of Object.entries({ code: "ZZZZZ-ZZZZZ", email: "owner@example.test", password: "x", confirm: "x" })) body.append(`_1_${k}`, v);
        body.append("0", JSON.stringify([{ status: "idle" }, "$K1"]));
        const origin = `http://127.0.0.1:${port}`;
        const res = await fetch(`${origin}/setup`, { method: "POST", headers: { "Next-Action": actionId, Accept: "text/x-component", Origin: origin }, body });
        const text = await res.text();
        assert.equal(res.status, 200, text.slice(0, 400));
        assert.match(res.headers.get("content-type") ?? "", /text\/x-component/);
        assert.match(text, /"status":"error"/, text.slice(0, 400));
            assert.ok(text.includes("ZZZZZ-ZZZZZ"), `the action ran and echoed the typed code: ${text.slice(0, 600)}`);
      } finally {
        const stopped = spawnSync(process.execPath, [cli, "stop"], { env, cwd: root, encoding: "utf8" });
        if (stopped.status !== 0 && started.exitCode === null) started.kill();
        await exited;
      }
    }
    assert.notEqual(keys[0], keys[1]);
  });
});

// ------------------------------------------------------------------------------------------------ Watchbell 1.1: review fixes (round 1)

describe("launchd: bounded restarts", () => {
  const launchdRun = (opts = {}) => {
    const h = harness({ platform: "darwin", ...opts });
    h.deps.uid = 501;
    h.deps.env.WATCHBELL_SERVICE = "launchd";
    return h;
  };

  test("the plist starts at most once a minute and tells run it is under launchd", () => {
    const plist = launchdPlist({ home: "/Users/a/.watchbell" }, { execPath: "/opt/node/bin/node", cliPath: "/opt/wb/bin/watchbell.mjs" });
    assert.ok(plist.includes("<key>ThrottleInterval</key><integer>60</integer>"), plist);
    assert.ok(plist.includes("<key>WATCHBELL_SERVICE</key><string>launchd</string>"), plist);
    assert.ok(plist.includes("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>"));
  });

  test("a start that can't succeed (port taken, nothing started) ends with exit 0 so launchd stops", async () => {
    const h = launchdRun({ fetch: async () => new Response("<html>", { status: 200 }) });
    assert.equal(await h.run(["run"]), 0);
    assert.equal(h.log.spawns.length, 0);
    const err = h.log.err.join("\n");
    assert.match(err, /Port 3100 is already in use by another program/);
    assert.match(err, /launchd will not start Watchbell again until you fix the problem above\. Then run: launchctl kickstart gui\/501\/watchbell/);
    // A database locked by a Watchbell in a terminal: the same.
    const locked = launchdRun({ lockAlive: [4040], fetch: healthy });
    holdLock(locked.dataDir, 4040);
    assert.equal(await locked.run(["run"]), 0);
    assert.match(locked.log.err.join("\n"), /already running/);
    // Outside launchd the exit code is unchanged.
    const plain = harness({ fetch: async () => new Response("<html>", { status: 200 }) });
    assert.equal(await plain.run(["run"]), 1);
    // A 1.0 plist written by hand has no WATCHBELL_SERVICE; launchd's own XPC_SERVICE_NAME counts on macOS.
    const old = harness({ platform: "darwin", env: { XPC_SERVICE_NAME: "watchbell" }, fetch: async () => new Response("<html>", { status: 200 }) });
    old.deps.uid = 501;
    assert.equal(await old.run(["run"]), 0);
  });

  test("a server that keeps failing: 4 failed exits are restarted, the 5th within 10 minutes ends with exit 0", async () => {
    const h = launchdRun({ exitWith: 1 });
    let now = Date.UTC(2026, 9, 20, 8);
    h.deps.now = () => now;
    const file = path.join(h.home, "launchd-failures.json");
    for (let i = 1; i <= 4; i++) {
      assert.equal(await h.run(["run"]), 1, `failure ${i} is restarted`);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, i);
      now += 60_000;
    }
    assert.equal(await h.run(["run"]), 0, "the 5th gives up");
    assert.match(h.log.err.at(-1), /stopped with an error 5 times in 10 minutes; launchd will not restart it again\. .+launchctl kickstart gui\/501\/watchbell/);
    assert.equal(fs.existsSync(file), false, "the count starts over after a kickstart");
    // Failures older than 10 minutes do not count; a clean exit is a clean exit.
    fs.writeFileSync(file, JSON.stringify([now - 11 * 60_000, now - 11 * 60_000, now - 11 * 60_000, now - 11 * 60_000]));
    assert.equal(await h.run(["run"]), 1);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 1);
    fs.writeFileSync(file, "{ corrupt");
    assert.equal(await h.run(["run"]), 1, "a corrupt count file counts as none");
    const ok = launchdRun({ exitWith: 0 });
    assert.equal(await ok.run(["run"]), 0);
    assert.equal(fs.existsSync(path.join(ok.home, "launchd-failures.json")), false);
  });
});

describe("launchd: re-install and update wait for the real state", () => {
  const stub = ({ printAnswers, bootout = 0, lockAlive = [] } = {}) => {
    const calls = [];
    const answers = [...printAnswers];
    const h = harness({
      platform: "darwin",
      lockAlive,
      runSync: (cmd, args) => {
        calls.push(args[0]);
        if (args[0] === "print") {
          const a = answers.length > 1 ? answers.shift() : answers[0];
          return a === "gone" ? { status: 113, stdout: "", stderr: "" } : { status: 0, stdout: `\tstate = ${a}\n`, stderr: "" };
        }
        if (args[0] === "bootout") return { status: bootout, stdout: "", stderr: bootout ? "Boot-out failed: 36: Operation now in progress\n" : "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    h.deps.uid = 501;
    let sleeps = 0;
    h.deps.sleep = async () => {
      sleeps++;
    };
    return { h, calls, sleeps: () => sleeps };
  };

  test("re-install waits until launchctl print says the old job is gone, then bootstraps", async () => {
    const { h, calls, sleeps } = stub({ printAnswers: ["running", "running", "running", "gone"] });
    assert.equal(await h.run(["service", "install", "--yes"]), 0, h.log.err.join("\n"));
    assert.deepEqual(calls, ["print", "bootout", "print", "print", "print", "bootstrap"]);
    assert.equal(sleeps(), 2);
  });

  test("bootout answering 36 (in progress) is waited for too", async () => {
    const { h, calls } = stub({ printAnswers: ["running", "running", "gone"], bootout: 36 });
    assert.equal(await h.run(["service", "install", "--yes"]), 0, h.log.err.join("\n"));
    assert.deepEqual(calls, ["print", "bootout", "print", "print", "bootstrap"]);
    assert.equal(h.log.err.length, 0);
  });

  test("a job that never goes away: no bootstrap after 30 s, and it says what to do", async () => {
    const { h, calls, sleeps } = stub({ printAnswers: ["running"] });
    assert.equal(await h.run(["service", "install", "--yes"]), 1);
    assert.ok(!calls.includes("bootstrap"));
    assert.equal(sleeps(), 120, "120 polls of 250 ms");
    assert.match(h.log.err.at(-1), /did not stop within 30 s\. Wait a moment, then run watchbell service install again\./);
  });

  test("an agent loaded but idle next to a Watchbell in a terminal: install refuses, update does not restart the agent", async () => {
    const { h, calls } = stub({ printAnswers: ["not running"], lockAlive: [3030] });
    holdLock(h.dataDir, 3030);
    assert.equal(await h.run(["service", "install", "--yes"]), 1);
    assert.match(h.log.err.at(-1), /running in a terminal/);
    assert.ok(!calls.includes("bootstrap"));
    fs.mkdirSync(path.join(h.deps.homedir, "Library", "LaunchAgents"), { recursive: true });
    fs.writeFileSync(path.join(h.deps.homedir, "Library", "LaunchAgents", "watchbell.plist"), launchdPlist({ home: h.home }, h.deps));
    registryFetch(h);
    calls.length = 0;
    assert.equal(await h.run(["update"]), 1);
    assert.match(h.log.err.join("\n"), /Watchbell is running \(process 3030\)\. Stop it first with "watchbell stop"/);
    assert.ok(!calls.includes("kickstart"));
  });
});

describe("update: hints, sudo, npm output", () => {
  test("sudo watchbell update is refused (root's home is not the user's Watchbell); root on its own is fine", async () => {
    const h = harness({ env: { SUDO_USER: "ana" } });
    const runs = [];
    h.deps.runSync = (cmd) => (runs.push(cmd), { status: 0, stdout: "", stderr: "" });
    h.deps.uid = 0;
    registryFetch(h);
    assert.equal(await h.run(["update"]), 1);
    assert.match(h.log.err[0], /^Run watchbell update as ana, without sudo/);
    assert.equal(runs.length, 0);
    const root = harness();
    root.deps.uid = 0;
    root.deps.runSync = (cmd) => (runs.push(cmd), { status: 0, stdout: "", stderr: "" });
    registryFetch(root);
    await root.run(["update"]);
    assert.ok(runs.includes("/usr/bin/npm"), "a root login (no SUDO_USER) updates its own install");
    assert.ok(!root.log.err.some((l) => l.includes("without sudo")));
  });

  test("with a running service, the manual steps name its stop and start (npm failed with EACCES)", async () => {
    const h = harness({ lockAlive: [700] });
    holdLock(h.dataDir, 700);
    h.deps.env.XDG_CONFIG_HOME = path.join(h.root, "config");
    const unitFile = path.join(h.root, "config", "systemd", "user", "watchbell.service");
    fs.mkdirSync(path.dirname(unitFile), { recursive: true });
    fs.writeFileSync(unitFile, systemdUnit({ home: h.home }, h.deps));
    h.deps.runSync = (cmd) => (cmd === "/usr/bin/npm" ? { status: 243, stdout: "", stderr: "npm error code EACCES" } : { status: 0, stdout: "", stderr: "" });
    registryFetch(h);
    assert.equal(await h.run(["update"]), 1);
    const err = h.log.err.join("\n");
    const steps = "Stop the systemd user service watchbell.service (systemctl --user stop watchbell.service), run sudo npm install -g watchbell@latest, then start it again (systemctl --user start watchbell.service).";
    assert.ok(err.includes(`npm's global folder is not writable by your user. ${steps}`), err);
    assert.ok(err.includes("Run it yourself: ") === false, "with a service the plain line would skip the stop");
    assert.ok(err.includes("Stop the systemd user service watchbell.service (systemctl --user stop watchbell.service), run npm install -g watchbell@latest, then start it again"));
  });

  test("npm's warnings are shown after a good update too", async () => {
    const h = harness();
    h.deps.runSync = (cmd) => (cmd === "/usr/bin/npm" ? { status: 0, stdout: "", stderr: "npm warn deprecated something@1.0.0\n" } : { status: 0, stdout: "", stderr: "" });
    registryFetch(h, { version: "10.0.0" });
    assert.equal(await h.run(["update"]), 1, "the folder still holds 9.9.9: npm installed elsewhere");
    assert.ok(h.log.err.includes("npm warn deprecated something@1.0.0"));
  });
});

describe("--host details", () => {
  const lan = () => {
    const h = harness({ exitWith: null });
    h.deps.fetch = async () => (h.log.spawns.length ? healthy() : Promise.reject(new Error("down")));
    h.deps.networkInterfaces = () => ({});
    return h;
  };
  const tunnel = (_o, err) => err.some((l) => l.startsWith("tunnel"));

  test("one address of another network: the printed, opened and server SITE_URL is that address", async () => {
    const h = lan();
    const done = startUntil(h, ["--host", "192.168.1.20"], tunnel);
    assert.equal(await done, 0);
    assert.ok(h.log.out.includes("Starting on http://192.168.1.20:3100 ..."), h.log.out.join("\n"));
    assert.ok(h.log.out.includes("Watchbell is running at http://192.168.1.20:3100"));
    assert.deepEqual(h.log.opened, ["http://192.168.1.20:3100"]);
    assert.equal(h.log.spawns[0].opts.env.SITE_URL, "http://192.168.1.20:3100");
    const v6 = lan();
    assert.equal(await startUntil(v6, ["--no-open", "--host", "2001:DB8::20"], tunnel), 0);
    assert.equal(v6.log.spawns[0].opts.env.SITE_URL, "http://[2001:db8::20]:3100");
    // A SITE_URL of the user's own stays.
    const own = lan();
    fs.mkdirSync(own.home, { recursive: true });
    fs.writeFileSync(own.envFile, "SITE_URL=https://ops.example.test\n");
    assert.equal(await startUntil(own, ["--no-open", "--host", "192.168.1.20"], tunnel), 0);
    assert.equal(own.log.spawns[0].opts.env.SITE_URL, "https://ops.example.test");
  });

  test("every spelling of the all-zero IPv6 address becomes :: (the health check probes [::1])", async () => {
    for (const v of ["0:0:0:0:0:0:0:0", "[0::0]", "::0", "[::]"]) assert.equal(parseArgs(["--host", v]).opts.host, "::", v);
    assert.equal(parseArgs(["--host", "FE80::1"]).opts.host, "fe80::1");
    const h = lan();
    assert.equal(await startUntil(h, ["--no-open", "--host", "0:0:0:0:0:0:0:0"], tunnel), 0);
    assert.equal(h.log.spawns[0].opts.env.HOSTNAME, "::");
  });
});

describe("update check timer", () => {
  test("start's background check does not keep the CLI alive; status waits for its answer", async () => {
    const unrefs = [];
    const spyTimer = (fn, ms) => {
      const t = setTimeout(fn, ms);
      const unref = t.unref.bind(t);
      t.unref = () => {
        unrefs.push(ms);
        return unref();
      };
      return t;
    };
    const h = harness({ exitWith: 1 });
    registryFetch(h, { registry: () => new Promise(() => {}) });
    h.deps.setTimer = spyTimer;
    h.deps.updateTimeoutMs = 20;
    assert.equal(await h.run(["--no-open"]), 1, "the server failed before it was ready");
    assert.deepEqual(unrefs, [20]);
    const s = harness();
    registryFetch(s);
    s.deps.setTimer = spyTimer;
    await s.run(["status"]);
    assert.deepEqual(unrefs, [20], "status keeps its timer referenced");
  });
});
