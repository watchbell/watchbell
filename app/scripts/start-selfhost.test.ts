import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { tmpBase } from "../test/tmp-base";

// Runs a copy of start-selfhost.mjs in a scratch app folder (path with spaces) whose node_modules holds a fake
// `next/dist/bin/next` that prints the arguments and environment it was started with, instead of a server.
const SCRIPT = fileURLToPath(new URL("./start-selfhost.mjs", import.meta.url));
const LIB = fileURLToPath(new URL("./selfhost-lib.mjs", import.meta.url));
const FAKE_NEXT = `console.log(JSON.stringify({ argv: process.argv.slice(2), env: {
  DATABASE_URL: process.env.DATABASE_URL, WATCHBELL_MODE: process.env.WATCHBELL_MODE,
  WATCHBELL_DATA_DIR: process.env.WATCHBELL_DATA_DIR, FROM_DOTENV: process.env.FROM_DOTENV } }));\n`;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function makeApp(files: Record<string, string> = {}): { root: string; app: string } {
  const root = mkdtempSync(path.join(tmpBase, "selfhost "));
  roots.push(root);
  const app = path.join(root, "my app");
  mkdirSync(path.join(app, "scripts"), { recursive: true });
  mkdirSync(path.join(app, "node_modules", "next", "dist", "bin"), { recursive: true });
  copyFileSync(SCRIPT, path.join(app, "scripts", "start-selfhost.mjs"));
  copyFileSync(LIB, path.join(app, "scripts", "selfhost-lib.mjs"));
  writeFileSync(path.join(app, "node_modules", "next", "dist", "bin", "next"), FAKE_NEXT);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(app, name), text);
  return { root, app };
}

function start(app: string, cwd: string, extra: Record<string, string> = {}) {
  const run = spawnSync(process.execPath, [path.join(app, "scripts", "start-selfhost.mjs")], {
    cwd,
    // Only what Node needs on Windows plus the case's own variables (no PORT/HOST/DATABASE_URL from this shell).
    // Cast: Next's global ProcessEnv type requires NODE_ENV, which this env deliberately leaves out.
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...extra } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout.trim().split(/\r?\n/).pop() ?? "") as { argv: string[]; env: Record<string, string | undefined> };
}

describe("start-selfhost.mjs", () => {
  it("uses HOST and PORT from app/.env, found next to the script whatever the cwd", () => {
    const { root, app } = makeApp({ ".env": "HOST=0.0.0.0\r\nPORT=4321\r\nFROM_DOTENV=yes\r\n" });
    const out = start(app, root);
    expect(out.argv).toEqual(["start", "-H", "0.0.0.0", "-p", "4321"]);
    expect(out.env.FROM_DOTENV).toBe("yes");
    expect(out.env.DATABASE_URL).toBe("pglite:");
    expect(out.env.WATCHBELL_MODE).toBe("selfhost");
  });

  it("lets the process environment win over app/.env", () => {
    const { app } = makeApp({ ".env": "HOST=0.0.0.0\nPORT=4321\nDATABASE_URL=pglite:./from-dotenv\n" });
    const out = start(app, app, { HOST: "127.0.0.2", PORT: "5555", DATABASE_URL: "pglite:./from-env" });
    expect(out.argv).toEqual(["start", "-H", "127.0.0.2", "-p", "5555"]);
    expect(out.env.DATABASE_URL).toBe("pglite:./from-env");
  });

  it("starts with the defaults when app/.env is missing, and never reads app/.env.local", () => {
    const { app } = makeApp({ ".env.local": "PORT=9999\nHOST=0.0.0.0\nDATABASE_URL=postgresql://u:p@db.example.test:5432/x\n" });
    const out = start(app, app);
    expect(out.argv).toEqual(["start", "-H", "127.0.0.1", "-p", "3100"]);
    expect(out.env.DATABASE_URL).toBe("pglite:");
    expect(out.env.WATCHBELL_DATA_DIR).toBe("./data");
  });

  it("keeps the data folder of an app/.env written before the rename (WATCHPOST_DATA_DIR); WATCHBELL_DATA_DIR wins", () => {
    const { app } = makeApp({ ".env": "WATCHPOST_DATA_DIR=./old-data\n" });
    expect(start(app, app).env.WATCHBELL_DATA_DIR).toBe("./old-data");
    expect(start(app, app, { WATCHBELL_DATA_DIR: "./new-data" }).env.WATCHBELL_DATA_DIR).toBe("./new-data");
    expect(start(app, app, { WATCHPOST_MODE: "cloud" }).env.WATCHBELL_MODE).toBe("selfhost");
  });

  it("removes a database lock whose pid now belongs to another program, and keeps one a Node.js process holds", async () => {
    // A live program that is not Node.js, like the one that got the pid of a server killed by a power cut.
    const other =
      process.platform === "win32"
        ? spawn(path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "PING.EXE"), ["-n", "60", "127.0.0.1"], { stdio: "ignore" })
        : spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const { app } = makeApp();
      const lock = path.join(app, "data", "pg", ".watchpost.lock");
      mkdirSync(path.dirname(lock), { recursive: true });
      writeFileSync(lock, String(other.pid));
      start(app, app);
      expect(existsSync(lock)).toBe(false);
      // This test runner is Node.js: its lock may be real and stays (the server then refuses, naming the file).
      writeFileSync(lock, String(process.pid));
      start(app, app);
      expect(existsSync(lock)).toBe(true);
    } finally {
      other.kill();
    }
  }, 30_000);
});
