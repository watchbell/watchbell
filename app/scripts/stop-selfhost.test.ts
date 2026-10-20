import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { tmpBase } from "../test/tmp-base";

// Runs a copy of stop-selfhost.mjs in a scratch app folder (paths with spaces) against a fake server: a node process
// that holds the PGlite lock file with its pid, answers /api/health and, unless told to ignore it, stops when the
// stop-request file appears (deletes it, closes, removes the lock, exits 0), like the real server's watcher.
const SCRIPT = fileURLToPath(new URL("./stop-selfhost.mjs", import.meta.url));
const LIB = fileURLToPath(new URL("./selfhost-lib.mjs", import.meta.url));
const FAKE_SERVER = `
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
const [dataDir, port, mode] = process.argv.slice(2);
const lock = path.join(dataDir, "pg", ".watchpost.lock");
const request = path.join(dataDir, "stop-request");
mkdirSync(path.dirname(lock), { recursive: true });
writeFileSync(lock, String(process.pid));
const server = http.createServer((_req, res) => res.end('{"ok":true}'));
server.listen(Number(port), "127.0.0.1", () => console.log("ready"));
if (mode !== "ignore") {
  setInterval(() => {
    if (!existsSync(request)) return;
    rmSync(request, { force: true });
    server.close();
    setTimeout(() => { rmSync(lock, { force: true }); process.exit(0); }, 300);
  }, 100);
}
`;

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill();
});
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function makeApp() {
  const root = mkdtempSync(path.join(tmpBase, "stop-selfhost "));
  roots.push(root);
  const app = path.join(root, "my app");
  mkdirSync(path.join(app, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, path.join(app, "scripts", "stop-selfhost.mjs"));
  copyFileSync(LIB, path.join(app, "scripts", "selfhost-lib.mjs"));
  const fake = path.join(root, "fake-server.mjs");
  writeFileSync(fake, FAKE_SERVER);
  const port = await freePort();
  writeFileSync(path.join(app, ".env"), `PORT=${port}\nHOST=0.0.0.0\nWATCHPOST_DATA_DIR=./var data\n`);
  const dataDir = path.join(app, "var data");
  return { root, app, fake, port, dataDir, request: path.join(dataDir, "stop-request") };
}

async function startFake(box: Awaited<ReturnType<typeof makeApp>>, mode = "obey"): Promise<ChildProcess> {
  const child = spawn(process.execPath, [box.fake, box.dataDir, String(box.port), mode], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (d: Buffer) => d.toString().includes("ready") && resolve());
    child.on("exit", () => reject(new Error("fake server exited early")));
  });
  return child;
}

function stop(app: string, args: string[] = []) {
  return spawnSync(process.execPath, [path.join(app, "scripts", "stop-selfhost.mjs"), ...args], {
    cwd: path.dirname(app), // not the app folder: the script finds app/.env next to itself
    // Only what Node needs on Windows (no PORT/HOST/WATCHPOST_DATA_DIR from this shell).
    // Cast: Next's global ProcessEnv type requires NODE_ENV, which this env deliberately leaves out.
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
}

describe("stop-selfhost.mjs", () => {
  it("writes the stop request where app/.env says and waits until the server is gone", async () => {
    const box = await makeApp();
    const server = await startFake(box);
    const exited = new Promise((r) => server.on("exit", r));
    const run = stop(box.app);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain("Watchbell stopped.");
    await exited;
    expect(server.exitCode).toBe(0);
    expect(existsSync(box.request)).toBe(false);
  });

  it("exits 1 with the fallback after the timeout, and takes its request back", async () => {
    const box = await makeApp();
    await startFake(box, "ignore");
    const run = stop(box.app, ["--timeout", "2"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Stop-ScheduledTask Watchbell");
    expect(run.stderr).toContain("Stop-ScheduledTask Watchpost"); // an older install that kept its task name
    expect(existsSync(box.request)).toBe(false);
  });

  it("says so and writes nothing when Watchbell is not running (a stale lock does not count)", async () => {
    const box = await makeApp();
    mkdirSync(path.join(box.dataDir, "pg"), { recursive: true });
    const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
    writeFileSync(path.join(box.dataDir, "pg", ".watchpost.lock"), dead.stdout.trim());
    const run = stop(box.app);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("not running");
    expect(existsSync(box.request)).toBe(false);
  });

  it("a lock whose pid is now another program is not a running Watchbell", async () => {
    const box = await makeApp();
    const other =
      process.platform === "win32"
        ? spawn(path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "PING.EXE"), ["-n", "60", "127.0.0.1"], { stdio: "ignore" })
        : spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    children.push(other);
    await new Promise((r) => setTimeout(r, 300));
    mkdirSync(path.join(box.dataDir, "pg"), { recursive: true });
    writeFileSync(path.join(box.dataDir, "pg", ".watchpost.lock"), String(other.pid));
    const run = stop(box.app);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("not running");
    expect(existsSync(box.request)).toBe(false);
  });

  it("names the lock file to delete when a live Node.js process holds it and nothing answers", async () => {
    const box = await makeApp();
    const idle = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    children.push(idle);
    mkdirSync(path.join(box.dataDir, "pg"), { recursive: true });
    const lock = path.join(box.dataDir, "pg", ".watchpost.lock");
    writeFileSync(lock, String(idle.pid));
    const run = stop(box.app, ["--timeout", "1"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`names process ${idle.pid}`);
    expect(run.stderr).toContain(`delete ${lock}`);
    expect(existsSync(box.request)).toBe(false);
  });

  it("rejects unknown arguments with exit 2", async () => {
    const box = await makeApp();
    expect(stop(box.app, ["--bogus"]).status).toBe(2);
  });
});
