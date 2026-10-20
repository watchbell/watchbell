import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpBase } from "../test/tmp-base";

const { schedulerStop, pollerStop } = vi.hoisted(() => ({ schedulerStop: vi.fn(), pollerStop: vi.fn() }));

const ready = vi.fn(async () => {});
const closeLocalDb = vi.fn(async () => {});
const startScheduler = vi.fn(() => ({ stop: schedulerStop }));
const startTelegramPoller = vi.fn(() => ({ stop: pollerStop }));
const ensureSetupCode = vi.fn<(opts: { key: Uint8Array; siteUrl: string }) => Promise<boolean>>(async () => true);
const installFetchGuard = vi.fn();
const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
vi.mock("@/db/client", () => ({ ready, closeLocalDb }));
vi.mock("@/lib/scheduler/scheduler", () => ({ startScheduler }));
vi.mock("@/lib/notify/telegram-poll", () => ({ startTelegramPoller }));
vi.mock("@/lib/demo/fetch-guard", () => ({ installFetchGuard }));
vi.mock("@/lib/local-auth/setup", () => ({ ensureSetupCode }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: KEY_B64, SITE_URL: "http://127.0.0.1:3100" }) }));

import { register } from "./instrumentation";

// Selfhost register() watches <WATCHBELL_DATA_DIR>/stop-request: point it at a scratch folder, never the real app/data.
const dataDir = mkdtempSync(path.join(tmpBase, "instrumentation-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe("register", () => {
  beforeEach(() => {
    vi.stubEnv("WATCHBELL_DATA_DIR", dataDir);
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    delete (globalThis as { __watchpostClockStarted?: boolean }).__watchpostClockStarted;
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("WATCHBELL_ALLOW_REMOTE_DB", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("starts nothing in cloud mode", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("WATCHBELL_MODE", "");
    await register();
    expect(ready).not.toHaveBeenCalled();
    expect(startScheduler).not.toHaveBeenCalled();
    expect(startTelegramPoller).not.toHaveBeenCalled();
    expect(ensureSetupCode).not.toHaveBeenCalled();
  });

  it("demo: installs the fetch guard, prepares db() and starts no scheduler, poller or setup code", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("WATCHBELL_MODE", "demo");
    for (const url of ["", "pglite:", "PGLITE:./x"]) {
      vi.stubEnv("DATABASE_URL", url);
      await register();
    }
    expect(installFetchGuard).toHaveBeenCalledTimes(3);
    expect(ready).toHaveBeenCalledTimes(3); // demo's ready() opens no database (src/db/client.test.ts)
    expect(installFetchGuard.mock.invocationCallOrder[0]).toBeLessThan(ready.mock.invocationCallOrder[0]);
    expect(startScheduler).not.toHaveBeenCalled();
    expect(startTelegramPoller).not.toHaveBeenCalled();
    expect(ensureSetupCode).not.toHaveBeenCalled();
  });

  it("demo: refuses any real DATABASE_URL (no override), without echoing it", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("WATCHBELL_MODE", "demo");
    vi.stubEnv("WATCHBELL_ALLOW_REMOTE_DB", "1");
    for (const url of [
      "postgresql://postgres.ref:s3cret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres",
      "postgres://user:s3cret@db.local:5432/x",
      "not a url",
    ]) {
      vi.stubEnv("DATABASE_URL", url);
      const err = await register().then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err?.message).toContain("Refusing to start");
      expect(err?.message).toContain("WATCHBELL_MODE=demo");
      expect(err?.message).not.toContain("s3cret");
    }
    expect(installFetchGuard).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });

  it("does not install the fetch guard in cloud or selfhost", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("WATCHBELL_MODE", "");
    await register();
    vi.stubEnv("WATCHBELL_MODE", "selfhost");
    vi.stubEnv("DATABASE_URL", "pglite:");
    await register();
    expect(installFetchGuard).not.toHaveBeenCalled();
  });

  it("starts nothing in the edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("WATCHBELL_MODE", "selfhost");
    await register();
    expect(ready).not.toHaveBeenCalled();
    expect(startScheduler).not.toHaveBeenCalled();
  });

  // Follow-up A3: next build also bundles this file for the Edge runtime. Only an import inside
  // `if (process.env.NEXT_RUNTIME === "nodejs")` is dropped from that bundle; anything else pulled PGlite, node:fs and
  // the demo's node:crypto into the Edge graph ("A Node.js API is used ... not supported in the Edge Runtime").
  it("keeps every Node-only import behind the nodejs check the bundler can drop", () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "instrumentation.ts"), "utf8").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/^\s*import\s/m);
    const imports = [...src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    expect(imports).toEqual(["./instrumentation-node"]);
    expect(src).toMatch(/if \(process\.env\.NEXT_RUNTIME === "nodejs"\)[^;]*import\("\.\/instrumentation-node"\)/);
  });

  it("in selfhost opens the database first, then starts the scheduler and the poller", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("WATCHBELL_MODE", "selfhost");
    await register();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(startScheduler).toHaveBeenCalledTimes(1);
    expect(startTelegramPoller).toHaveBeenCalledTimes(1);
    expect(ready.mock.invocationCallOrder[0]).toBeLessThan(startScheduler.mock.invocationCallOrder[0]);
    expect(startScheduler.mock.invocationCallOrder[0]).toBeLessThan(startTelegramPoller.mock.invocationCallOrder[0]);
  });

  it("in selfhost prepares the first-run setup code after the database is open, with the decoded key", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("WATCHBELL_MODE", "selfhost");
    await register();
    await register();
    expect(ensureSetupCode).toHaveBeenCalledTimes(1);
    const opts = ensureSetupCode.mock.calls[0][0];
    expect(Buffer.from(opts.key).equals(Buffer.alloc(32, 7))).toBe(true);
    expect(opts.siteUrl).toBe("http://127.0.0.1:3100");
    expect(ready.mock.invocationCallOrder[0]).toBeLessThan(ensureSetupCode.mock.invocationCallOrder[0]);
  });

  it("a failing setup-code step is logged and the server still starts", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("WATCHBELL_MODE", "selfhost");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ensureSetupCode.mockRejectedValueOnce(new Error("db locked"));
    await register();
    expect(warn).toHaveBeenCalledWith("Watchbell setup code could not be prepared: db locked");
    expect(startScheduler).toHaveBeenCalledTimes(1);
  });

  it("starts the scheduler and the poller only once per process, even if register() runs again", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("WATCHBELL_MODE", "selfhost");
    await register();
    await register();
    expect(startScheduler).toHaveBeenCalledTimes(1);
    expect(startTelegramPoller).toHaveBeenCalledTimes(1);
  });

  it("refuses to start against a hosted Supabase DATABASE_URL, without echoing the URL", async () => {
    const url = "postgresql://postgres.ref:s3cret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres";
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("WATCHBELL_MODE", "selfhost");
    vi.stubEnv("DATABASE_URL", url);
    const err = await register().then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toContain("Refusing to start");
    expect(err?.message).toContain("DATABASE_URL=pglite:");
    expect(err?.message).toContain("WATCHBELL_ALLOW_REMOTE_DB=1");
    expect(err?.message).not.toContain("s3cret");
    expect(err?.message).not.toContain("pooler");
    expect(ready).not.toHaveBeenCalled();
    expect(startScheduler).not.toHaveBeenCalled();
    expect(startTelegramPoller).not.toHaveBeenCalled();
  });

  it("refuses an unparsable or multi-host DATABASE_URL, but starts on a normal self-managed Postgres", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("WATCHBELL_MODE", "selfhost");
    for (const url of ["not a url", "postgres://u:s3cret@a.local:5432,b.local:5432/x"]) {
      vi.stubEnv("DATABASE_URL", url);
      const err = await register().then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err?.message).toContain("Refusing to start");
      expect(err?.message).not.toContain("s3cret");
    }
    expect(startScheduler).not.toHaveBeenCalled();
    vi.stubEnv("DATABASE_URL", "postgres://user:pass@db.local:5432/x");
    await register();
    expect(startScheduler).toHaveBeenCalledTimes(1);
  });

  it("starts with the pglite: sentinel", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("WATCHBELL_MODE", "selfhost");
    vi.stubEnv("DATABASE_URL", "pglite:");
    await register();
    expect(startScheduler).toHaveBeenCalledTimes(1);
  });

  it("starts them against a hosted Supabase database when WATCHBELL_ALLOW_REMOTE_DB=1", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("WATCHBELL_MODE", "selfhost");
    vi.stubEnv("DATABASE_URL", "postgres://postgres:pw@db.abcdef.supabase.co:5432/postgres");
    vi.stubEnv("WATCHBELL_ALLOW_REMOTE_DB", "1");
    await register();
    expect(startScheduler).toHaveBeenCalledTimes(1);
    expect(startTelegramPoller).toHaveBeenCalledTimes(1);
  });

  it("starts them against a self-managed Postgres", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("WATCHBELL_MODE", "selfhost");
    vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost:5432/watchbell");
    await register();
    expect(startScheduler).toHaveBeenCalledTimes(1);
  });

  describe("signal handling", () => {
    const stubbed = () => {
      const handlers: Record<string, () => void> = {};
      vi.spyOn(process, "on").mockImplementation(((sig: string, fn: () => void) => {
        handlers[sig] = fn;
        return process;
      }) as unknown as typeof process.on);
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as unknown as typeof process.exit);
      return { handlers, exit };
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it("registers no handlers unless NEXT_MANUAL_SIG_HANDLE=true", async () => {
      const { handlers } = stubbed();
      vi.stubEnv("NEXT_RUNTIME", "nodejs");
      vi.stubEnv("WATCHBELL_MODE", "selfhost");
      vi.stubEnv("NEXT_MANUAL_SIG_HANDLE", "");
      await register();
      expect(Object.keys(handlers)).toEqual([]);
    });

    it("on SIGTERM stops the jobs, closes PGlite once and exits 0", async () => {
      const { handlers, exit } = stubbed();
      vi.stubEnv("NEXT_RUNTIME", "nodejs");
      vi.stubEnv("WATCHBELL_MODE", "selfhost");
      vi.stubEnv("NEXT_MANUAL_SIG_HANDLE", "true");
      await register();
      // SIGHUP is always handled: a clean stop with a terminal, ignored without one (nohup, services); shutdown.test.ts
      // covers both cases.
      expect(Object.keys(handlers).sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
      handlers.SIGTERM();
      handlers.SIGINT();
      await flush();
      expect(schedulerStop).toHaveBeenCalledTimes(1);
      expect(pollerStop).toHaveBeenCalledTimes(1);
      expect(closeLocalDb).toHaveBeenCalledTimes(1);
      expect(schedulerStop.mock.invocationCallOrder[0]).toBeLessThan(closeLocalDb.mock.invocationCallOrder[0]);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
      // a repeat signal later neither re-runs the shutdown nor exits again
      handlers.SIGTERM();
      await flush();
      expect(closeLocalDb).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
    });

    it("a stop-request file runs the same clean stop once, without signal handlers (Windows)", async () => {
      const { handlers, exit } = stubbed();
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      try {
        vi.stubEnv("NEXT_RUNTIME", "nodejs");
        vi.stubEnv("WATCHBELL_MODE", "selfhost");
        vi.stubEnv("NEXT_MANUAL_SIG_HANDLE", "");
        const file = path.join(dataDir, "stop-request");
        writeFileSync(file, "left over");
        const old = new Date(Date.now() - 24 * 60 * 60 * 1000); // older than this (test) process
        utimesSync(file, old, old);
        await register();
        expect(existsSync(file)).toBe(false); // a request from before this start is dropped
        expect(Object.keys(handlers)).toEqual([]);
        vi.advanceTimersByTime(3000);
        await flush();
        expect(exit).not.toHaveBeenCalled();
        writeFileSync(file, "");
        vi.advanceTimersByTime(1000);
        await flush();
        expect(existsSync(file)).toBe(false);
        expect(schedulerStop).toHaveBeenCalledTimes(1);
        expect(closeLocalDb).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(0);
        writeFileSync(file, "");
        vi.advanceTimersByTime(5000);
        await flush();
        expect(exit).toHaveBeenCalledTimes(1); // the watcher stopped after the first request
      } finally {
        vi.useRealTimers();
      }
    });

    it("a stop request written while the server starts still stops it at the first poll", async () => {
      const { exit } = stubbed();
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      try {
        vi.stubEnv("NEXT_RUNTIME", "nodejs");
        vi.stubEnv("WATCHBELL_MODE", "selfhost");
        vi.stubEnv("NEXT_MANUAL_SIG_HANDLE", "");
        const file = path.join(dataDir, "stop-request");
        writeFileSync(file, ""); // newer than this process: written during startup
        await register();
        expect(existsSync(file)).toBe(true);
        vi.advanceTimersByTime(1000);
        await flush();
        expect(existsSync(file)).toBe(false);
        expect(closeLocalDb).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
